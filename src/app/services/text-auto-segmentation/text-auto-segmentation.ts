import { Service, inject, signal, DestroyRef, PLATFORM_ID } from '@angular/core';
import { GBDTEvaluator, type GbdtModelJson, type GbdtPredictionResult } from './evaluator/gbdt-evaluator';
import { extractBoundaryFeatures } from './evaluator/feature-extractor';
import { type TextSegment } from '../text-segmentation/text-segmentation';

/**
 * Output data resulting from automatic text segmentation.
 */
export interface TextAutoSegmentationResult {
  newSegments: TextSegment[],
  junctions: number,
  segmentsCount: number,
  confidence: number,
}

/**
 * Service managing client-side automated text segmentation and joining via universal GBDT modeling.
 */
@Service()
export class TextAutoSegmentationService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef, { optional: true });

  public static readonly MODEL_PATH = 'models/gbdt_universal.json';

  /**
   * Indicates whether the model JSON is actively being downloaded.
   */
  public readonly isDownloading = signal<boolean>(false);

  /**
   * Indicates whether boundary inference is actively executing.
   */
  public readonly isProcessing = signal<boolean>(false);

  /**
   * Number of joined segment boundaries, or null if segmentation has not been run.
   */
  public readonly junctions = signal<number | null>(null);

  /**
   * Number of resulting parent segments, or null if segmentation has not been run.
   */
  public readonly segmentsCount = signal<number | null>(null);

  /**
   * Average confidence percentage (0-100), or null if segmentation has not been run.
   */
  public readonly confidence = signal<number | null>(null);

  private evaluatorInstance: GBDTEvaluator | null = null;
  private modelLoadPromise: Promise<GBDTEvaluator> | null = null;

  constructor() {
    this.destroyRef?.onDestroy(() => {
      this.evaluatorInstance = null;
      this.modelLoadPromise = null;
    });
  }

  /**
   * Configures a custom or mock GBDTEvaluator instance, primarily for unit testing.
   *
   * @param evaluator The custom evaluator or null to reset to network loading.
   */
  public setCustomEvaluator(evaluator: GBDTEvaluator | null): void {
    this.evaluatorInstance = evaluator;
    this.modelLoadPromise = evaluator ? Promise.resolve(evaluator) : null;
  }

  /**
   * Resets all segmentation metrics back to null (displaying dashes in the UI).
   */
  public reset(): void {
    this.junctions.set(null);
    this.segmentsCount.set(null);
    this.confidence.set(null);
  }

  /**
   * Ensures the universal GBDT model dump is loaded and ready for evaluation.
   *
   * @returns A promise resolving to the GBDTEvaluator instance.
   */
  public async ensureModelLoaded(): Promise<GBDTEvaluator> {
    if (this.evaluatorInstance) {
      return this.evaluatorInstance;
    }

    if (this.modelLoadPromise) {
      return this.modelLoadPromise;
    }

    this.isDownloading.set(true);

    this.modelLoadPromise = (async () => {
      try {
        const response = await fetch(TextAutoSegmentationService.MODEL_PATH);
        if (!response.ok) {
          throw new Error(
            'Failed to load universal GBDT model: ' + response.status + ' ' + response.statusText
          );
        }
        const modelJson: GbdtModelJson = await response.json();
        this.evaluatorInstance = new GBDTEvaluator(modelJson);
        return this.evaluatorInstance;
      } finally {
        this.isDownloading.set(false);
      }
    })();

    return this.modelLoadPromise;
  }

  /**
   * Executes automated boundary classification over current text segments using the 2-stage universal GBDT cascade.
   *
   * @param currentSegments The current text segment hierarchy.
   * @returns The rebuilt segment tree and the calculated summary metrics.
   */
  public async autoSegment(currentSegments: readonly TextSegment[]): Promise<TextAutoSegmentationResult> {
    if (currentSegments.length === 0) {
      this.junctions.set(0);
      this.segmentsCount.set(0);
      this.confidence.set(0);
      return {
        newSegments: [],
        junctions: 0,
        segmentsCount: 0,
        confidence: 0,
      };
    }

    const flattenedPieces = this.flattenSegments(currentSegments);

    if (flattenedPieces.length <= 1) {
      const singleSegs = flattenedPieces.map((p) => ({ ...p, linkedChildren: [] }));
      this.junctions.set(0);
      this.segmentsCount.set(singleSegs.length);
      this.confidence.set(100);
      return {
        newSegments: singleSegs,
        junctions: 0,
        segmentsCount: singleSegs.length,
        confidence: 100,
      };
    }

    const evaluator = await this.ensureModelLoaded();
    this.isProcessing.set(true);

    try {
      let junctionsCount = 0;
      let totalConfidence = 0.0;
      const newSegments: TextSegment[] = [];

      let currentParent: TextSegment = {
        ...flattenedPieces[0],
        linkedChildren: [],
      };
      newSegments.push(currentParent);

      for (let i = 0; i < flattenedPieces.length - 1; i++) {
        const pieceA = flattenedPieces[i];
        const pieceB = flattenedPieces[i + 1];

        const features = extractBoundaryFeatures(pieceA, pieceB);
        const result: GbdtPredictionResult = evaluator.predictCascade(features, pieceA, pieceB);

        totalConfidence += result.confidence;

        if (result.decision === 1) {
          // Join pieceB into currentParent's linkedChildren.
          junctionsCount++;
          const childSegment: TextSegment = {
            ...pieceB,
            linkedChildren: [],
          };
          currentParent.linkedChildren.push(childSegment);
        } else {
          // Split: pieceB starts a new parent segment.
          currentParent = {
            ...pieceB,
            linkedChildren: [],
          };
          newSegments.push(currentParent);
        }
      }

      const boundaryCount = flattenedPieces.length - 1;
      const avgConfidencePct = Math.round((totalConfidence / boundaryCount) * 100);
      const resultingSegmentsCount = newSegments.length;

      this.junctions.set(junctionsCount);
      this.segmentsCount.set(resultingSegmentsCount);
      this.confidence.set(avgConfidencePct);

      return {
        newSegments,
        junctions: junctionsCount,
        segmentsCount: resultingSegmentsCount,
        confidence: avgConfidencePct,
      };
    } finally {
      this.isProcessing.set(false);
    }
  }

  /**
   * Flattens a hierarchical segment list into linear document appearance order.
   *
   * @param segments The segments to flatten.
   * @returns A flat array of text segments in sequential order.
   */
  public flattenSegments(segments: readonly TextSegment[]): TextSegment[] {
    const flattened: TextSegment[] = [];
    for (const seg of segments) {
      flattened.push({
        ...seg,
        linkedChildren: [],
      });
      if (seg.linkedChildren && seg.linkedChildren.length > 0) {
        flattened.push(...this.flattenSegments(seg.linkedChildren));
      }
    }
    return flattened;
  }
}

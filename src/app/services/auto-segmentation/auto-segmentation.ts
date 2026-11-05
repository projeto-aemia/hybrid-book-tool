import { Service, inject, signal, computed, DestroyRef } from '@angular/core';
import { LandmarkExtractionService } from '../landmark-extraction/landmark-extraction';
import { VideoSegmentationService } from '../video-segmentation/video-segmentation';
import { UndoRedoService } from '../undo/undo-redo';
import { MediaFiles, type MediaFileId } from '../media-files/media-files';
import { AutoSegmentVideoCommand } from '../undo/commands/video-segmentation-commands';
import {
  type AutoSegmentationModel,
  type AutoSegmentationResult,
} from './auto-segmentation-model.interface';
import { WristVerticalAdvantageModel } from './models/wrist-vertical-advantage-model';
import { type LandmarkExtractionProgress } from '../landmark-extraction/landmark-data.interface';

/**
 * Service orchestrating automatic video segmentation workflows across modular algorithms.
 */
@Service()
export class AutoSegmentationService {
  private readonly landmarkExtractionService = inject(LandmarkExtractionService);
  private readonly videoSegmentationService = inject(VideoSegmentationService);
  private readonly undoRedoService = inject(UndoRedoService);
  private readonly mediaFilesService = inject(MediaFiles);
  private readonly destroyRef = inject(DestroyRef, { optional: true });

  public static readonly MIN_LAMBDA = 0.0;
  public static readonly MAX_LAMBDA = 2.0;
  public static readonly DEFAULT_LAMBDA = 1.0;

  public readonly models = signal<AutoSegmentationModel[]>([new WristVerticalAdvantageModel()]);
  public readonly selectedModelId = signal<string>('wrist-vertical-advantage');

  public readonly selectedModel = computed<AutoSegmentationModel>(() => {
    const list = this.models();
    const targetId = this.selectedModelId();
    return list.find((m) => m.id === targetId) ?? list[0];
  });

  public readonly lambda = signal<number>(AutoSegmentationService.DEFAULT_LAMBDA);
  public readonly isProcessing = signal<boolean>(false);
  public readonly currentProgress = signal<LandmarkExtractionProgress | null>(null);
  public readonly activeMediaFileId = signal<MediaFileId | null>(null);
  public readonly statusMessage = signal<string>('');

  public readonly progressPercentage = computed<number>(() => {
    return this.currentProgress()?.progressPercentage ?? 0;
  });

  public readonly currentFrame = computed<number>(() => {
    return this.currentProgress()?.currentFrame ?? 0;
  });

  public readonly totalFrames = computed<number>(() => {
    return this.currentProgress()?.totalFrames ?? 0;
  });

  private activeAbortController: AbortController | null = null;

  constructor() {
    this.destroyRef?.onDestroy(() => {
      this.cancel();
    });
  }

  /**
   * Registers an additional auto-segmentation algorithm or heuristic model.
   *
   * @param model The auto-segmentation model to register.
   */
  public registerModel(model: AutoSegmentationModel): void {
    this.models.update((list) => {
      const filtered = list.filter((m) => m.id !== model.id);
      return [...filtered, model];
    });
  }

  /**
   * Selects the active auto-segmentation algorithm model by ID.
   *
   * @param modelId The ID of the model to select.
   */
  public selectModel(modelId: string): void {
    if (this.models().some((m) => m.id === modelId)) {
      this.selectedModelId.set(modelId);
    }
  }

  /**
   * Updates the lambda activity threshold parameter, clamped between 0 and 2.
   *
   * @param value The desired lambda threshold value.
   */
  public setLambda(value: number): void {
    const clamped = Math.max(
      AutoSegmentationService.MIN_LAMBDA,
      Math.min(AutoSegmentationService.MAX_LAMBDA, Number(value.toFixed(2))),
    );
    this.lambda.set(clamped);
  }

  /**
   * Checks whether pose landmarks are cached in memory for the given media file.
   *
   * @param mediaFileId The ID of the media file.
   * @returns True if landmarks are already extracted and cached.
   */
  public hasCachedLandmarks(mediaFileId: MediaFileId): boolean {
    return this.landmarkExtractionService.hasCachedLandmarks(mediaFileId);
  }

  /**
   * Executes the automatic segmentation process for the specified media file.
   * Extracts landmarks if not cached, evaluates the active heuristic model, applies cuts to the timeline,
   * and records an undoable command in the Undo/Redo history.
   *
   * @param mediaFileId The media file to segment.
   * @param options Optional configuration including forcing re-extraction of landmarks.
   */
  public async runAutoSegmentation(
    mediaFileId: MediaFileId,
    options?: { forceReextract?: boolean },
  ): Promise<void> {
    if (this.isProcessing()) {
      return;
    }

    const mediaFiles = this.mediaFilesService.mediaFiles();
    const mediaFile = mediaFiles.find((f) => f.id === mediaFileId);
    if (!mediaFile) {
      throw new Error(`Media file with ID ${mediaFileId} not found.`);
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeMediaFileId.set(mediaFileId);
    this.isProcessing.set(true);
    this.statusMessage.set('Iniciando extração de marcos corporais...');

    try {
      const landmarksData = await this.landmarkExtractionService.extractLandmarks(mediaFile, {
        forceReextract: options?.forceReextract,
        abortSignal: abortController.signal,
        onProgress: (progress) => {
          this.currentProgress.set(progress);
          if (progress.phase === 'initializing') {
            this.statusMessage.set('Inicializando modelos e decodificador...');
          } else if (progress.phase === 'detecting') {
            const { progressPercentage: pct, currentFrame: cur, totalFrames: tot } = progress;
            this.statusMessage.set(
              `Extraindo marcos corporais: ${pct}% (${cur}/${tot} frames)`,
            );
          } else if (progress.phase === 'completed') {
            this.statusMessage.set('Extração de marcos concluída. Processando heurística...');
          }
        },
      });

      const model = this.selectedModel();
      const result: AutoSegmentationResult = model.segment({
        landmarks: landmarksData.landmarks,
        framerate: landmarksData.framerate,
        duration: landmarksData.duration,
        lambda: this.lambda(),
      });

      const applied = this.videoSegmentationService.applyAutoSegments(mediaFileId, result.segments);
      const afterSegments = this.videoSegmentationService.segments();
      const afterOrder = this.videoSegmentationService.correlationOrder();

      const command = new AutoSegmentVideoCommand(
        applied.beforeSegments,
        applied.beforeCorrelationOrder,
        afterSegments,
        afterOrder,
        mediaFileId,
        this.videoSegmentationService,
      );
      this.undoRedoService.execute(command);

      this.statusMessage.set(
        `Segmentação automática concluída com sucesso: ${result.segments.length} segmentos gerados.`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.statusMessage.set('Segmentação automática cancelada.');
      } else {
        const message = error instanceof Error ? error.message : 'Erro desconhecido.';
        this.statusMessage.set(`Falha na segmentação automática: ${message}`);
        throw error;
      }
    } finally {
      this.isProcessing.set(false);
      this.activeAbortController = null;
    }
  }

  /**
   * Recalculates segment boundaries in real-time when the lambda threshold parameter changes,
   * provided landmark data is already cached.
   *
   * @param mediaFileId The media file ID to re-segment.
   * @param newLambda The new lambda threshold.
   */
  public recalculateWithLambda(mediaFileId: MediaFileId, newLambda: number): void {
    this.setLambda(newLambda);

    const landmarksData = this.landmarkExtractionService.getCachedLandmarks(mediaFileId);
    if (!landmarksData) {
      return;
    }

    const model = this.selectedModel();
    const result: AutoSegmentationResult = model.segment({
      landmarks: landmarksData.landmarks,
      framerate: landmarksData.framerate,
      duration: landmarksData.duration,
      lambda: this.lambda(),
    });

    const applied = this.videoSegmentationService.applyAutoSegments(mediaFileId, result.segments);
    const afterSegments = this.videoSegmentationService.segments();
    const afterOrder = this.videoSegmentationService.correlationOrder();

    const command = new AutoSegmentVideoCommand(
      applied.beforeSegments,
      applied.beforeCorrelationOrder,
      afterSegments,
      afterOrder,
      mediaFileId,
      this.videoSegmentationService,
    );
    this.undoRedoService.execute(command);
  }

  /**
   * Cancels the active landmark extraction or segmentation operation.
   */
  public cancel(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    this.landmarkExtractionService.cancelActiveExtraction();
    this.isProcessing.set(false);
    this.statusMessage.set('Operação cancelada pelo usuário.');
  }
}

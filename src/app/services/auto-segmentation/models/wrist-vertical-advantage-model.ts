import {
  type AutoSegmentationModel,
  type AutoSegmentationInput,
  type AutoSegmentationResult,
  type SegmentInterval,
} from '../auto-segmentation-model.interface';
import {
  type PoseLandmarkPoint,
  type FramePoseLandmarks,
} from '../../landmark-extraction/landmark-data.interface';

interface RegionItem {
  start: number,
  end: number,
  isActive: boolean,
}

/**
 * Auto-segmentation model based on the wrist vertical advantage to elbow energy heuristic.
 * Detects active sign language signing regions from subsampled MediaPipe pose landmarks.
 */
export class WristVerticalAdvantageModel implements AutoSegmentationModel {
  public readonly id = 'wrist-vertical-advantage';
  public readonly name = 'Vantagem vertical do punho';
  public readonly description =
    'Heurística baseada na vantagem vertical do punho normalizada pela distância dos ombros com detector de energia';

  public static readonly DEFAULT_LAMBDA = 1.0;
  public static readonly DEFAULT_MIN_REGION_LENGTH = 4;
  public static readonly MIN_SEGMENT_DURATION_OFFSET = 0.033;

  // MediaPipe pose landmark indices
  private static readonly LEFT_SHOULDER = 11;
  private static readonly RIGHT_SHOULDER = 12;
  private static readonly LEFT_ELBOW = 13;
  private static readonly RIGHT_ELBOW = 14;
  private static readonly LEFT_WRIST = 15;
  private static readonly RIGHT_WRIST = 16;
  private static readonly MIN_REQUIRED_LANDMARKS = 17;

  private cachedLandmarksRef: readonly FramePoseLandmarks[] | null = null;
  private cachedFramerate: number | null = null;
  private cachedShortTimeEnergy: Float32Array | null = null;

  /**
   * Executes the heuristic segmentation pipeline over the provided landmark data.
   *
   * @param input Kinematic landmark data, framerate, duration, and optional lambda threshold.
   * @returns Active sample regions and segment intervals in seconds.
   */
  public segment(input: AutoSegmentationInput): AutoSegmentationResult {
    const { landmarks, framerate, duration } = input;
    const lambdaParam = input.lambda ?? WristVerticalAdvantageModel.DEFAULT_LAMBDA;
    const minRegionLength = input.minRegionLength ?? WristVerticalAdvantageModel.DEFAULT_MIN_REGION_LENGTH;

    if (landmarks.length === 0 || duration <= 0 || framerate <= 0) {
      return { activeRegions: [], segments: [] };
    }

    let shortTimeEnergy: Float32Array;
    let totalSamples: number;

    const isEnergyCached =
      this.cachedLandmarksRef === landmarks &&
      this.cachedFramerate === framerate &&
      this.cachedShortTimeEnergy !== null;

    if (isEnergyCached) {
      shortTimeEnergy = this.cachedShortTimeEnergy!;
      totalSamples = shortTimeEnergy.length;
    } else {
      // 1. Continuity preprocessing (forward/backward fill missing frames)
      const validPoseLandmarks: PoseLandmarkPoint[][] = [];
      let firstValid: PoseLandmarkPoint[] | null = null;

      for (const plm of landmarks) {
        if (plm && plm.length >= WristVerticalAdvantageModel.MIN_REQUIRED_LANDMARKS) {
          firstValid = plm;
          break;
        }
      }

      if (!firstValid) {
        return { activeRegions: [], segments: [] };
      }

      let lastValid = firstValid;
      for (const plm of landmarks) {
        if (plm && plm.length >= WristVerticalAdvantageModel.MIN_REQUIRED_LANDMARKS) {
          lastValid = plm;
        }
        validPoseLandmarks.push(lastValid);
      }

      totalSamples = validPoseLandmarks.length;

      // 2. 1D signal reduction
      const instantEnergy = new Float32Array(totalSamples);

      for (let i = 0; i < totalSamples; i++) {
        const plm = validPoseLandmarks[i];

        const leftShoulder = plm[WristVerticalAdvantageModel.LEFT_SHOULDER];
        const rightShoulder = plm[WristVerticalAdvantageModel.RIGHT_SHOULDER];
        const leftElbow = plm[WristVerticalAdvantageModel.LEFT_ELBOW];
        const rightElbow = plm[WristVerticalAdvantageModel.RIGHT_ELBOW];
        const leftWrist = plm[WristVerticalAdvantageModel.LEFT_WRIST];
        const rightWrist = plm[WristVerticalAdvantageModel.RIGHT_WRIST];

        const dWeL = leftElbow.y - leftWrist.y;
        const dWeR = rightElbow.y - rightWrist.y;

        const dxS = rightShoulder.x - leftShoulder.x;
        const dyS = rightShoulder.y - leftShoulder.y;
        const dzS = rightShoulder.z - leftShoulder.z;
        const dS = Math.max(1e-6, Math.sqrt(dxS * dxS + dyS * dyS + dzS * dzS));

        const dTildeWeL = Math.max(0, dWeL + dS);
        const dTildeWeR = Math.max(0, dWeR + dS);

        const dTildeWeRms = Math.sqrt((dTildeWeL * dTildeWeL + dTildeWeR * dTildeWeR) / 2.0);
        const normalizedRms = dTildeWeRms / dS;

        instantEnergy[i] = normalizedRms * normalizedRms;
      }

      // 3. Energy-based activity detection (centered 1-second moving average)
      const windowSize = Math.max(1, Math.round(1.0 * framerate));
      const halfLeft = Math.ceil(-windowSize / 2);
      const halfRight = Math.floor(windowSize / 2);

      shortTimeEnergy = new Float32Array(totalSamples);

      for (let t = 0; t < totalSamples; t++) {
        let sum = 0;
        for (let k = halfLeft; k <= halfRight; k++) {
          const idx = t + k;
          if (idx >= 0 && idx < totalSamples) {
            sum += instantEnergy[idx];
          }
        }
        shortTimeEnergy[t] = sum / windowSize;
      }

      this.cachedLandmarksRef = landmarks;
      this.cachedFramerate = framerate;
      this.cachedShortTimeEnergy = shortTimeEnergy;
    }

    const signalActive = new Uint8Array(totalSamples);
    for (let t = 0; t < totalSamples; t++) {
      signalActive[t] = shortTimeEnergy[t] > lambdaParam ? 1 : 0;
    }

    // 4. Segment filtering (eliminate segments <= 3 frames / merge small regions)
    const activeRegions = this.detectSignalActiveRegions(signalActive, minRegionLength);

    // 5. Convert active regions to segment intervals in seconds
    const segments: SegmentInterval[] = [];
    for (const [startSample, endSample] of activeRegions) {
      const startTime = Math.max(0, startSample / framerate);
      const endTime = Math.min(duration, endSample / framerate);

      if (endTime - startTime >= WristVerticalAdvantageModel.MIN_SEGMENT_DURATION_OFFSET) {
        segments.push({ startTime, endTime });
      }
    }

    return {
      activeRegions,
      segments,
      shortTimeEnergy,
    };
  }

  /**
   * Builds alternating active/inactive regions and merges segments smaller than minRegionLength into neighbors.
   *
   * @param signalActive Binary array representing per-sample activity.
   * @param minRegionLength Minimum required contiguous samples for a region (e.g. 4).
   * @returns Merged active sample intervals [startSample, endSample].
   */
  private detectSignalActiveRegions(
    signalActive: Uint8Array,
    minRegionLength: number,
  ): [number, number][] {
    if (signalActive.length <= minRegionLength) {
      return [];
    }

    let sumInitial = 0;
    for (let i = 0; i < minRegionLength; i++) {
      sumInitial += signalActive[i];
    }

    let isActive = sumInitial / minRegionLength > 0.5;
    let start = 0;

    const regions: RegionItem[] = [];
    for (let i = minRegionLength; i < signalActive.length; i++) {
      const activeNow = signalActive[i] === 1;
      if (activeNow && !isActive) {
        regions.push({ start, end: i, isActive: false });
        start = i;
        isActive = true;
      } else if (!activeNow && isActive) {
        regions.push({ start, end: i, isActive: true });
        start = i;
        isActive = false;
      }
    }
    regions.push({ start, end: signalActive.length, isActive });

    // Merge any regions smaller than minRegionLength into neighbors
    const merged: RegionItem[] = [];
    for (let r = 0; r < regions.length; r++) {
      const region = regions[r];
      const length = region.end - region.start;
      if (length >= minRegionLength || merged.length === 0) {
        merged.push({ ...region });
        continue;
      }

      const prev = merged.pop()!;
      const nextIdx = r + 1;
      if (nextIdx < regions.length) {
        const next = regions[nextIdx];
        const prevLen = prev.end - prev.start;
        const nextLen = next.end - next.start;
        if (prevLen >= nextLen) {
          merged.push({ start: prev.start, end: region.end, isActive: prev.isActive });
        } else {
          merged.push({ ...prev });
          regions[nextIdx] = { start: region.start, end: next.end, isActive: next.isActive };
        }
      } else {
        merged.push({ start: prev.start, end: region.end, isActive: prev.isActive });
      }
    }

    const activeOnly: [number, number][] = [];
    for (const reg of merged) {
      if (reg.isActive) {
        activeOnly.push([reg.start, reg.end]);
      }
    }

    return this.mergeAdjacentRegions(activeOnly);
  }

  /**
   * Merges overlapping or adjacent regions of the same activity type.
   *
   * @param regions List of region boundaries [start, end].
   * @returns Consolidated non-overlapping region list.
   */
  private mergeAdjacentRegions(regions: [number, number][]): [number, number][] {
    if (regions.length === 0) {
      return [];
    }

    const merged: [number, number][] = [[regions[0][0], regions[0][1]]];
    for (let i = 1; i < regions.length; i++) {
      const [s, e] = regions[i];
      const last = merged[merged.length - 1];
      if (s <= last[1]) {
        last[1] = Math.max(last[1], e);
      } else {
        merged.push([s, e]);
      }
    }

    return merged;
  }
}

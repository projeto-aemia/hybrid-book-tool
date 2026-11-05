import { Service, inject, PLATFORM_ID, DestroyRef } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { MediaFiles, type MediaFile, type MediaFileId } from '../media-files/media-files';
import {
  type VideoLandmarksData,
  type FramePoseLandmarks,
  type PoseLandmarkPoint,
  type LandmarkExtractionOptions,
} from './landmark-data.interface';

interface MockCanvasSink {
  getCanvas: (timestamp: number) => Promise<{ canvas: HTMLCanvasElement }>,
}

/**
 * Service responsible for decoding video frames via Mediabunny and extracting MediaPipe pose landmarks.
 */
@Service()
export class LandmarkExtractionService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly mediaFilesService = inject(MediaFiles, { optional: true });
  private readonly destroyRef = inject(DestroyRef, { optional: true });

  public static readonly DEFAULT_FPS = 5;
  public static readonly INFERENCE_FRAME_DIMENSION = 256;
  public static readonly WASM_LOCAL_URL = 'assets/mediapipe/tasks-vision/wasm';
  public static readonly LOCAL_MODEL_PATH = 'models/pose_landmarker_lite.task';

  private readonly landmarksCache = new Map<MediaFileId, VideoLandmarksData>();
  private activeAbortController: AbortController | null = null;
  private poseLandmarkerPromise: Promise<PoseLandmarker> | null = null;
  private poseLandmarkerInstance: PoseLandmarker | null = null;

  constructor() {
    this.destroyRef?.onDestroy(() => {
      this.cancelActiveExtraction();
      this.landmarksCache.clear();
      this.disposePoseLandmarker();
    });
  }

  /**
   * Sets a mock or custom PoseLandmarker instance, primarily used for automated unit testing.
   *
   * @param landmarker The custom landmarker instance, or null to reset.
   */
  public setCustomPoseLandmarker(landmarker: PoseLandmarker | null): void {
    this.poseLandmarkerInstance = landmarker;
    this.poseLandmarkerPromise = landmarker ? Promise.resolve(landmarker) : null;
  }

  /**
   * Checks whether extracted landmark data is already cached for the given media file ID.
   *
   * @param mediaFileId The media file identifier.
   * @returns True if landmarks are cached in memory.
   */
  public hasCachedLandmarks(mediaFileId: MediaFileId): boolean {
    return this.landmarksCache.has(mediaFileId);
  }

  /**
   * Retrieves the cached landmark data for a media file, if available.
   *
   * @param mediaFileId The media file identifier.
   * @returns The cached VideoLandmarksData, or undefined if not cached.
   */
  public getCachedLandmarks(mediaFileId: MediaFileId): VideoLandmarksData | undefined {
    return this.landmarksCache.get(mediaFileId);
  }

  /**
   * Stores pre-extracted landmark data directly into the cache.
   * Useful when restoring project state or loading pre-computed data.
   *
   * @param data The video landmarks data to store.
   */
  public setCachedLandmarks(data: VideoLandmarksData): void {
    this.landmarksCache.set(data.mediaFileId, data);
  }

  /**
   * Clears cached landmarks for a specific media file or all files.
   *
   * @param mediaFileId Optional file ID to clear; if omitted, clears all cached landmarks.
   */
  public clearCache(mediaFileId?: MediaFileId): void {
    if (mediaFileId) {
      this.landmarksCache.delete(mediaFileId);
    } else {
      this.landmarksCache.clear();
    }
  }

  /**
   * Cancels any currently active landmark extraction operation.
   */
  public cancelActiveExtraction(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  /**
   * Extracts MediaPipe pose landmarks from a video file at the target framerate (defaults to 5 FPS).
   * Runs in non-blocking fashion by yielding to the event loop on each frame to maintain UI responsiveness.
   *
   * @param mediaFile The video media file to process.
   * @param options Configuration options including cancellation signal and progress listener.
   * @returns A promise resolving to the extracted VideoLandmarksData.
   * @throws If executed outside a browser environment or if video decoding fails.
   */
  public async extractLandmarks(
    mediaFile: MediaFile,
    options?: LandmarkExtractionOptions,
  ): Promise<VideoLandmarksData> {
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error('Landmark extraction can only be performed in a browser environment.');
    }

    if (!options?.forceReextract && this.landmarksCache.has(mediaFile.id)) {
      const cached = this.landmarksCache.get(mediaFile.id)!;
      options?.onProgress?.({
        mediaFileId: mediaFile.id,
        currentFrame: cached.landmarks.length,
        totalFrames: cached.landmarks.length,
        progressPercentage: 100,
        phase: 'completed',
      });
      return cached;
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const onExternalAbort = () => abortController.abort();
    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const targetFps = options?.targetFps ?? LandmarkExtractionService.DEFAULT_FPS;
    const interval = 1 / targetFps;

    options?.onProgress?.({
      mediaFileId: mediaFile.id,
      currentFrame: 0,
      totalFrames: 0,
      progressPercentage: 0,
      phase: 'initializing',
    });

    const input = new Input({
      source: new BlobSource(mediaFile.file),
      formats: ALL_FORMATS,
    });

    try {
      if (abortController.signal.aborted) {
        throw new DOMException('Landmark extraction was cancelled.', 'AbortError');
      }

      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw new Error('No video track found in the media file.');
      }

      const canDecode = await videoTrack.canDecode();
      if (!canDecode) {
        throw new Error('Unable to decode video track.');
      }

      const firstTimestamp = (await videoTrack.getFirstTimestamp()) ?? 0;
      const lastTimestamp = (await videoTrack.computeDuration()) ?? 0;
      const duration = Math.max(0, lastTimestamp - firstTimestamp);

      const timestamps: number[] = [];
      for (let t = 0; t <= duration; t += interval) {
        timestamps.push(Math.round(t * 1000) / 1000);
      }
      if (timestamps.length === 0) {
        timestamps.push(0);
      }

      const totalFrames = timestamps.length;
      const clampedTimestamps = timestamps.map((t) => (duration > 0
        ? Math.min(lastTimestamp, Math.max(firstTimestamp, firstTimestamp + t))
        : firstTimestamp));

      const displayWidth = await videoTrack.getDisplayWidth();
      const displayHeight = await videoTrack.getDisplayHeight();
      const targetDimension = LandmarkExtractionService.INFERENCE_FRAME_DIMENSION;
      const width = displayWidth < displayHeight
        ? Math.max(32, Math.floor(targetDimension * displayWidth / displayHeight))
        : targetDimension;
      const height = displayHeight < displayWidth
        ? Math.max(32, Math.floor(targetDimension * displayHeight / displayWidth))
        : targetDimension;

      const sink = new CanvasSink(videoTrack, {
        width,
        height,
        fit: 'fill',
        poolSize: 1,
      });

      const landmarker = await this.getOrCreatePoseLandmarker();

      if (abortController.signal.aborted) {
        throw new DOMException('Landmark extraction was cancelled.', 'AbortError');
      }

      options?.onProgress?.({
        mediaFileId: mediaFile.id,
        currentFrame: 0,
        totalFrames,
        progressPercentage: 0,
        phase: 'detecting',
      });

      const frameLandmarks: FramePoseLandmarks[] = [];
      let frameIndex = 0;

      if (typeof sink.canvasesAtTimestamps === 'function') {
        for await (const wrappedCanvas of sink.canvasesAtTimestamps(clampedTimestamps)) {
          if (abortController.signal.aborted) {
            throw new DOMException('Landmark extraction was cancelled.', 'AbortError');
          }

          const targetTime = timestamps[frameIndex] ?? (frameIndex * interval);
          const timestampMs = Math.max(frameIndex, Math.round(targetTime * 1000));

          let landmarksForFrame: PoseLandmarkPoint[] | null = null;
          if (wrappedCanvas?.canvas) {
            try {
              const result = landmarker.detectForVideo(wrappedCanvas.canvas, timestampMs);
              if (result.landmarks && result.landmarks.length > 0) {
                landmarksForFrame = result.landmarks[0].map((lm) => ({
                  x: lm.x,
                  y: lm.y,
                  z: lm.z,
                  visibility: lm.visibility,
                }));
              }
            } catch (_e) {
              // Frame inference error: mark frame landmarks as null
            }
          }

          frameLandmarks.push(landmarksForFrame);
          frameIndex++;

          options?.onProgress?.({
            mediaFileId: mediaFile.id,
            currentFrame: frameIndex,
            totalFrames,
            progressPercentage: Math.min(100, Math.round((frameIndex / totalFrames) * 100)),
            phase: 'detecting',
          });

          // Non-blocking yield to event loop
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      } else if (typeof (sink as unknown as MockCanvasSink).getCanvas === 'function') {
        // Fallback for mock environments
        for (const clampedT of clampedTimestamps) {
          if (abortController.signal.aborted) {
            throw new DOMException('Landmark extraction was cancelled.', 'AbortError');
          }

          const mockSink = sink as unknown as MockCanvasSink;
          const wrappedCanvas = await mockSink.getCanvas(clampedT);
          const targetTime = timestamps[frameIndex] ?? (frameIndex * interval);
          const timestampMs = Math.max(frameIndex, Math.round(targetTime * 1000));

          let landmarksForFrame: PoseLandmarkPoint[] | null = null;
          if (wrappedCanvas?.canvas) {
            try {
              const result = landmarker.detectForVideo(wrappedCanvas.canvas, timestampMs);
              if (result.landmarks && result.landmarks.length > 0) {
                landmarksForFrame = result.landmarks[0].map((lm) => ({
                  x: lm.x,
                  y: lm.y,
                  z: lm.z,
                  visibility: lm.visibility,
                }));
              }
            } catch (_e) {
              // Frame inference error
            }
          }

          frameLandmarks.push(landmarksForFrame);
          frameIndex++;

          options?.onProgress?.({
            mediaFileId: mediaFile.id,
            currentFrame: frameIndex,
            totalFrames,
            progressPercentage: Math.min(100, Math.round((frameIndex / totalFrames) * 100)),
            phase: 'detecting',
          });

          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      const resultData: VideoLandmarksData = {
        mediaFileId: mediaFile.id,
        framerate: targetFps,
        duration,
        sampledTimestamps: timestamps,
        landmarks: frameLandmarks,
      };

      this.landmarksCache.set(mediaFile.id, resultData);

      options?.onProgress?.({
        mediaFileId: mediaFile.id,
        currentFrame: totalFrames,
        totalFrames,
        progressPercentage: 100,
        phase: 'completed',
      });

      return resultData;
    } finally {
      input.dispose();
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener('abort', onExternalAbort);
      }
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  /**
   * Initializes or returns the singleton MediaPipe PoseLandmarker task instance.
   *
   * @returns A promise resolving to the PoseLandmarker instance.
   */
  private async getOrCreatePoseLandmarker(): Promise<PoseLandmarker> {
    if (this.poseLandmarkerInstance) {
      return this.poseLandmarkerInstance;
    }

    if (!this.poseLandmarkerPromise) {
      this.poseLandmarkerPromise = this.initPoseLandmarker();
    }

    try {
      this.poseLandmarkerInstance = await this.poseLandmarkerPromise;
      return this.poseLandmarkerInstance;
    } catch (error) {
      this.poseLandmarkerPromise = null;
      throw error;
    }
  }

  /**
   * Instantiates the PoseLandmarker task with WASM assets and model paths.
   *
   * @returns The created PoseLandmarker instance.
   */
  private async initPoseLandmarker(): Promise<PoseLandmarker> {
    const vision = await FilesetResolver.forVisionTasks(LandmarkExtractionService.WASM_LOCAL_URL);

    // Try GPU delegate first, fallback to CPU delegate
    try {
      return await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: LandmarkExtractionService.LOCAL_MODEL_PATH,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch (_gpuError) {
      // Fallback with CPU delegate
      return await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: LandmarkExtractionService.LOCAL_MODEL_PATH,
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
  }

  /**
   * Cleans up the PoseLandmarker task instance.
   */
  private disposePoseLandmarker(): void {
    if (this.poseLandmarkerInstance) {
      try {
        this.poseLandmarkerInstance.close?.();
      } catch (_e) {
        // Ignore close errors during tear down
      }
      this.poseLandmarkerInstance = null;
    }
    this.poseLandmarkerPromise = null;
  }
}

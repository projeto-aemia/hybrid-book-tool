import { type MediaFileId } from '../media-files/media-files';

/**
 * A 3D landmark coordinate with an optional visibility score in normalized coordinates [0, 1].
 */
export interface PoseLandmarkPoint {
  x: number,
  y: number,
  z: number,
  visibility?: number,
}

/**
 * Pose landmarks detected for a single video frame.
 * Array of 33 normalized landmarks if a person was detected, or null if no pose was detected.
 */
export type FramePoseLandmarks = PoseLandmarkPoint[] | null;

/**
 * Complete set of pose landmarks extracted from a video media file at a target sampling framerate (e.g. 5 FPS).
 */
export interface VideoLandmarksData {
  mediaFileId: MediaFileId,
  framerate: number,
  duration: number,
  sampledTimestamps: number[],
  landmarks: FramePoseLandmarks[],
}

/**
 * Progress notification emitted during landmark extraction.
 */
export interface LandmarkExtractionProgress {
  mediaFileId: MediaFileId,
  currentFrame: number,
  totalFrames: number,
  progressPercentage: number,
  phase: 'initializing' | 'decoding' | 'detecting' | 'completed',
}

/**
 * Options configuring landmark extraction for a media file.
 */
export interface LandmarkExtractionOptions {
  targetFps?: number,
  abortSignal?: AbortSignal,
  onProgress?: (progress: LandmarkExtractionProgress) => void,
  forceReextract?: boolean,
}

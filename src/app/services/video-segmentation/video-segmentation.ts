import { Service, inject, signal, computed, effect, DestroyRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { MediaFiles, type MediaFileId, type MediaFile } from '../media-files/media-files';
import {
  Thumbnail,
  type SegmentThumbnailGenerationRequest,
} from '../thumbnail/thumbnail';
import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';

export interface VideoSegment {
  id?: string,
  fileId: MediaFileId,
  name: string,
  startTime: number,
  endTime: number,
  thumbnail: string | null,
}

/**
 * Service managing video segmentation state, temporal ordering, and correlation ordering.
 */
@Service()
export class VideoSegmentationService {
  private readonly mediaFilesService = inject(MediaFiles);
  private readonly thumbnailService = inject(Thumbnail);
  private readonly destroyRef = inject(DestroyRef, { optional: true });

  public static readonly DEFAULT_FPS = 30;
  public static readonly MIN_SEGMENT_DURATION = 0.05;
  public static readonly DEFAULT_GAP_SPLIT_DURATION = 1;
  public static readonly JOIN_NEAR_THRESHOLD = 1;
  public static readonly MIN_SEGMENT_DURATION_OFFSET = 0.033;
  public static readonly THUMBNAIL_DEBOUNCE_TIME_MS = 250;
  private static readonly FALLBACK_FILE_ORDER_INDEX = 9999;

  public readonly segments = signal<VideoSegment[]>([]);
  public readonly correlationOrder = signal<string[]>([]);

  private readonly fileDurations = new Map<MediaFileId, number>();
  private readonly fileFps = new Map<MediaFileId, number>();
  private readonly segmentThumbnailDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly segmentThumbnailSubscriptions = new Map<string, Subscription>();
  private lastKnownFileIds = new Set<MediaFileId>();

  /**
   * Computed list of segments in correlation order, preserving the ordering set in the Correlation component.
   */
  public readonly correlatedSegments = computed<VideoSegment[]>(() => {
    const allSegments = this.segments();
    const order = this.correlationOrder();
    const segmentMap = new Map<string, VideoSegment>();
    const unorderedSegments: VideoSegment[] = [];

    for (const segment of allSegments) {
      if (segment.id) {
        segmentMap.set(segment.id, segment);
      } else {
        unorderedSegments.push(segment);
      }
    }

    const result: VideoSegment[] = [];
    const visited = new Set<string>();

    for (const id of order) {
      const seg = segmentMap.get(id);
      if (seg) {
        result.push(seg);
        visited.add(id);
      }
    }

    for (const seg of allSegments) {
      if (seg.id && !visited.has(seg.id)) {
        result.push(seg);
      }
    }

    for (const seg of unorderedSegments) {
      result.push(seg);
    }

    return result;
  });

  constructor() {
    effect(() => {
      const mediaFiles = this.mediaFilesService.mediaFiles();
      void this.syncSegmentsWithMediaFiles(mediaFiles);
    });

    this.destroyRef?.onDestroy(() => {
      for (const timer of this.segmentThumbnailDebounceTimers.values()) {
        clearTimeout(timer);
      }
      this.segmentThumbnailDebounceTimers.clear();
      for (const sub of this.segmentThumbnailSubscriptions.values()) {
        sub.unsubscribe();
      }
      this.segmentThumbnailSubscriptions.clear();
      this.thumbnailService?.freeAllSegmentThumbnails?.();
    });
  }

  /**
   * Finds the segment covering the specified timestamp for a given media file.
   *
   * @param fileId The media file ID.
   * @param time The timestamp in seconds.
   * @returns The matching segment, or null if none exists.
   */
  public findSegmentAtTime(fileId: MediaFileId, time: number): VideoSegment | null {
    const fileSegments = this.segments()
      .filter((s) => s.fileId === fileId)
      .sort((a, b) => a.startTime - b.startTime);

    for (let i = 0; i < fileSegments.length; i++) {
      const seg = fileSegments[i];
      const isLast = i === fileSegments.length - 1;
      if (time >= seg.startTime && (time < seg.endTime || (isLast && time <= seg.endTime))) {
        return seg;
      }
    }
    return null;
  }

  /**
   * Formats a standardized segment display name with time bounds.
   *
   * @param fileName The name of the parent media file.
   * @param startTime The segment start timestamp in seconds.
   * @param endTime The segment end timestamp in seconds.
   * @returns The formatted segment name.
   */
  private formatSegmentName(fileName: string, startTime: number, endTime: number): string {
    return `Segmento de ${fileName} (${this.formatTimestamp(startTime)} \u2013 ${this.formatTimestamp(endTime)})`;
  }

  /**
   * Retrieves the duration in seconds of a specific media file.
   *
   * @param fileId The ID of the media file.
   * @returns The duration in seconds, or undefined if unknown.
   */
  public getFileDuration(fileId: MediaFileId): number | undefined {
    return this.fileDurations.get(fileId);
  }

  /**
   * Retrieves the estimated or computed frame rate of a specific media file.
   *
   * @param fileId The ID of the media file.
   * @returns The frames per second, defaulting to DEFAULT_FPS.
   */
  public getFileFps(fileId: MediaFileId): number {
    return this.fileFps.get(fileId) ?? VideoSegmentationService.DEFAULT_FPS;
  }

  /**
   * Formats a timestamp in seconds to a human-readable string (MM:SS or HH:MM:SS).
   *
   * @param seconds The timestamp in seconds.
   * @returns The formatted timestamp string.
   */
  public formatTimestamp(seconds: number): string {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) {
      seconds = 0;
    }

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    const pad = (num: number) => num.toString().padStart(2, '0');

    if (hours > 0) {
      return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
    }

    return `${pad(minutes)}:${pad(secs)}`;
  }

  /**
   * Splits a segment at a given timestamp into two contiguous segments, or creates a new 1-second segment
   * if the timestamp is currently in an unsegmented gap.
   *
   * @param fileId The ID of the target media file.
   * @param timestamp The timestamp in seconds to split at.
   * @returns The created segment, or null if splitting is not possible.
   */
  public splitSegment(fileId: MediaFileId, timestamp: number): VideoSegment | null {
    const currentSegments = this.segments();
    const fileSegments = currentSegments.filter((seg) => seg.fileId === fileId);
    const targetSegment = fileSegments.find((seg) => timestamp > seg.startTime && timestamp < seg.endTime);

    if (targetSegment) {
      const segDuration = targetSegment.endTime - targetSegment.startTime;
      if (segDuration < VideoSegmentationService.MIN_SEGMENT_DURATION) {
        return null;
      }

      const mediaFile = this.mediaFilesService.mediaFiles().find((f) => f.id === fileId);
      const fileName = mediaFile?.name ?? 'Vídeo';

      const leftSegment: VideoSegment = {
        id: targetSegment.id ?? this.createSegmentId(),
        fileId,
        name: this.formatSegmentName(fileName, targetSegment.startTime, timestamp),
        startTime: targetSegment.startTime,
        endTime: timestamp,
        thumbnail: targetSegment.thumbnail,
      };

      const rightSegment: VideoSegment = {
        id: this.createSegmentId(),
        fileId,
        name: this.formatSegmentName(fileName, timestamp, targetSegment.endTime),
        startTime: timestamp,
        endTime: targetSegment.endTime,
        thumbnail: null,
      };

      const updatedSegments: VideoSegment[] = [];
      for (const seg of currentSegments) {
        if (seg === targetSegment || (targetSegment.id && seg.id === targetSegment.id)) {
          updatedSegments.push(leftSegment, rightSegment);
        } else {
          updatedSegments.push(seg);
        }
      }

      this.sortSegmentsTemporally(updatedSegments);
      this.segments.set(updatedSegments);

      this.correlationOrder.update((order) => {
        const index = targetSegment.id ? order.indexOf(targetSegment.id) : -1;
        if (index >= 0) {
          const newOrder = [...order];
          newOrder.splice(index, 1, leftSegment.id!, rightSegment.id!);
          return newOrder;
        }
        return [...order, leftSegment.id!, rightSegment.id!];
      });

      if (rightSegment.id) {
        this.requestSegmentThumbnail(rightSegment.id);
      }

      return rightSegment;
    }

    const duration = this.fileDurations.get(fileId) ?? 1;
    const nextSegment = fileSegments
      .filter((seg) => seg.startTime >= timestamp)
      .sort((a, b) => a.startTime - b.startTime)[0];

    const maxEnd = nextSegment ? nextSegment.startTime : duration;
    const startTime = Math.max(0, Math.min(timestamp, maxEnd));
    const endTime = Math.min(startTime + VideoSegmentationService.DEFAULT_GAP_SPLIT_DURATION, maxEnd);

    if (endTime <= startTime) {
      return null;
    }

    const mediaFile = this.mediaFilesService.mediaFiles().find((f) => f.id === fileId);
    const fileName = mediaFile?.name ?? 'Vídeo';

    const newSegment: VideoSegment = {
      id: this.createSegmentId(),
      fileId,
      name: this.formatSegmentName(fileName, startTime, endTime),
      startTime,
      endTime,
      thumbnail: null,
    };

    const updated = [...currentSegments, newSegment];
    this.sortSegmentsTemporally(updated);
    this.segments.set(updated);

    this.correlationOrder.update((order) => [...order, newSegment.id!]);

    if (newSegment.id) {
      this.requestSegmentThumbnail(newSegment.id);
    }

    return newSegment;
  }

  /**
   * Retrieves the pair of segments that can be joined at a given timestamp, if any.
   *
   * @param fileId The ID of the media file.
   * @param timestamp The timestamp in seconds.
   * @returns An object with the left and right segments, or null if no join is allowed.
   */
  public getJoinableSegments(
    fileId: MediaFileId,
    timestamp: number
  ): { left: VideoSegment, right: VideoSegment } | null {
    const fileSegments = this.segments()
      .filter((seg) => seg.fileId === fileId)
      .sort((a, b) => a.startTime - b.startTime);

    if (fileSegments.length < 2) {
      return null;
    }

    // Condition 1: Check if timestamp is between two segments (in an unsegmented gap or boundary)
    for (let i = 0; i < fileSegments.length - 1; i++) {
      const left = fileSegments[i];
      const right = fileSegments[i + 1];
      if (timestamp >= left.endTime && timestamp <= right.startTime) {
        return { left, right };
      }
    }

    // Condition 2: Check if timestamp is inside a segment and near its start or end
    for (let i = 0; i < fileSegments.length; i++) {
      const seg = fileSegments[i];
      if (timestamp >= seg.startTime && timestamp <= seg.endTime) {
        const distToStart = timestamp - seg.startTime;
        const distToEnd = seg.endTime - timestamp;
        const nearStart = distToStart <= VideoSegmentationService.JOIN_NEAR_THRESHOLD;
        const nearEnd = distToEnd <= VideoSegmentationService.JOIN_NEAR_THRESHOLD;

        if (nearStart && nearEnd) {
          if (distToStart <= distToEnd) {
            if (i > 0) {
              return { left: fileSegments[i - 1], right: seg };
            } else if (i < fileSegments.length - 1) {
              return { left: seg, right: fileSegments[i + 1] };
            }
          } else {
            if (i < fileSegments.length - 1) {
              return { left: seg, right: fileSegments[i + 1] };
            } else if (i > 0) {
              return { left: fileSegments[i - 1], right: seg };
            }
          }
        } else if (nearStart) {
          if (i > 0) {
            return { left: fileSegments[i - 1], right: seg };
          }
        } else if (nearEnd) {
          if (i < fileSegments.length - 1) {
            return { left: seg, right: fileSegments[i + 1] };
          }
        }

        return null;
      }
    }

    return null;
  }

  /**
   * Determines whether segments can be joined at the given timestamp.
   *
   * @param fileId The ID of the media file.
   * @param timestamp The timestamp in seconds.
   * @returns True if two segments can be joined at the given timestamp.
   */
  public canJoinSegments(fileId: MediaFileId, timestamp: number): boolean {
    return this.getJoinableSegments(fileId, timestamp) !== null;
  }

  /**
   * Joins two adjacent segments together at the given playhead timestamp.
   *
   * @param fileId The ID of the media file.
   * @param timestamp The timestamp in seconds.
   * @returns The merged segment, or null if joining is not possible.
   */
  public joinSegments(fileId: MediaFileId, timestamp: number): VideoSegment | null {
    const joinable = this.getJoinableSegments(fileId, timestamp);
    if (!joinable) {
      return null;
    }

    const { left, right } = joinable;
    const currentSegments = this.segments();
    const mediaFile = this.mediaFilesService.mediaFiles().find((f) => f.id === fileId);
    const fileName = mediaFile?.name ?? 'Vídeo';

    // Clean up right segment's thumbnail resources
    if (right.id) {
      const timer = this.segmentThumbnailDebounceTimers.get(right.id);
      if (timer) {
        clearTimeout(timer);
        this.segmentThumbnailDebounceTimers.delete(right.id);
      }
      const sub = this.segmentThumbnailSubscriptions.get(right.id);
      if (sub) {
        sub.unsubscribe();
        this.segmentThumbnailSubscriptions.delete(right.id);
      }
      this.thumbnailService.freeSegmentThumbnail(right.id);
    }

    const joinedSegment: VideoSegment = {
      id: left.id ?? this.createSegmentId(),
      fileId,
      name: this.formatSegmentName(fileName, left.startTime, right.endTime),
      startTime: left.startTime,
      endTime: right.endTime,
      thumbnail: left.thumbnail,
    };

    const updatedSegments = currentSegments
      .filter((seg) => seg.id !== right.id)
      .map((seg) => (seg.id === left.id ? joinedSegment : seg));

    this.sortSegmentsTemporally(updatedSegments);
    this.segments.set(updatedSegments);

    this.correlationOrder.update((order) => {
      return order.filter((id) => id !== right.id);
    });

    if (joinedSegment.id && !joinedSegment.thumbnail) {
      this.requestSegmentThumbnail(joinedSegment.id);
    }

    return joinedSegment;
  }

  /**
   * Determines whether a segment can be split at the given timestamp.
   *
   * @param fileId The ID of the media file.
   * @param timestamp The timestamp in seconds.
   * @returns True if the timestamp is strictly inside a segment of sufficient duration.
   */
  public canSplitSegment(fileId: MediaFileId, timestamp: number): boolean {
    const fileSegments = this.segments().filter((seg) => seg.fileId === fileId);
    const targetSegment = fileSegments.find((seg) => timestamp > seg.startTime && timestamp < seg.endTime);
    if (!targetSegment) {
      return false;
    }
    return (targetSegment.endTime - targetSegment.startTime) >= VideoSegmentationService.MIN_SEGMENT_DURATION;
  }

  /**
   * Determines whether a 1-second segment can be created in an unsegmented gap at the given timestamp.
   *
   * @param fileId The ID of the media file.
   * @param timestamp The timestamp in seconds.
   * @returns True if the timestamp is in a gap with available duration to create a segment.
   */
  public canCreateSegmentInGap(fileId: MediaFileId, timestamp: number): boolean {
    const fileSegments = this.segments().filter((seg) => seg.fileId === fileId);
    const insideSegment = fileSegments.some((seg) => timestamp > seg.startTime && timestamp < seg.endTime);
    if (insideSegment) {
      return false;
    }

    const duration = this.fileDurations.get(fileId) ?? 1;
    const nextSegment = fileSegments
      .filter((seg) => seg.startTime >= timestamp)
      .sort((a, b) => a.startTime - b.startTime)[0];

    const maxEnd = nextSegment ? nextSegment.startTime : duration;
    const startTime = Math.max(0, Math.min(timestamp, maxEnd));
    const endTime = Math.min(startTime + VideoSegmentationService.DEFAULT_GAP_SPLIT_DURATION, maxEnd);

    return endTime > startTime;
  }

  /**
   * Applies automatically generated segment intervals to a media file, replacing any existing
   * segments for that file while preserving segments of other files.
   *
   * @param fileId The ID of the media file.
   * @param intervals Array of start and end times in seconds.
   * @returns Snapshot of before state and the newly created segments.
   */
  public applyAutoSegments(
    fileId: MediaFileId,
    intervals: readonly { startTime: number, endTime: number }[],
  ): { beforeSegments: VideoSegment[], beforeCorrelationOrder: string[], newSegments: VideoSegment[] } {
    const currentSegments = this.segments();
    const currentCorrelationOrder = this.correlationOrder();
    const mediaFiles = this.mediaFilesService.mediaFiles();
    const mediaFile = mediaFiles.find((f) => f.id === fileId);
    const fileName = mediaFile ? mediaFile.name : `Arquivo ${fileId}`;
    const duration = this.fileDurations.get(fileId) ?? 0;

    const existingForFile = currentSegments.filter((s) => s.fileId === fileId);
    const removedIds = new Set(existingForFile.map((s) => s.id).filter(Boolean) as string[]);

    for (const id of removedIds) {
      const timer = this.segmentThumbnailDebounceTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.segmentThumbnailDebounceTimers.delete(id);
      }
      const sub = this.segmentThumbnailSubscriptions.get(id);
      if (sub) {
        sub.unsubscribe();
        this.segmentThumbnailSubscriptions.delete(id);
      }
      this.thumbnailService?.freeSegmentThumbnail?.(id);
    }

    const otherSegments = currentSegments.filter((s) => s.fileId !== fileId);

    let validIntervals = intervals;
    if (validIntervals.length === 0 && duration > 0) {
      validIntervals = [{ startTime: 0, endTime: duration }];
    }

    const newSegments: VideoSegment[] = validIntervals.map((interval) => {
      const startTime = Math.max(0, interval.startTime);
      const endTime = Math.min(duration > 0 ? duration : interval.endTime, interval.endTime);
      const id = this.createSegmentId();
      return {
        id,
        fileId,
        name: this.formatSegmentName(fileName, startTime, endTime),
        startTime,
        endTime,
        thumbnail: null,
      };
    });

    const updatedSegments = [...otherSegments, ...newSegments];
    this.sortSegmentsTemporally(updatedSegments);
    this.segments.set(updatedSegments);

    const updatedCorrelationOrder = currentCorrelationOrder.filter((id) => !removedIds.has(id));
    const newSegmentIds = newSegments.map((s) => s.id!).filter(Boolean);
    const finalCorrelationOrder = [...updatedCorrelationOrder, ...newSegmentIds];
    this.correlationOrder.set(finalCorrelationOrder);

    for (const seg of newSegments) {
      if (seg.id) {
        this.requestSegmentThumbnail(seg.id);
      }
    }

    return {
      beforeSegments: currentSegments,
      beforeCorrelationOrder: currentCorrelationOrder,
      newSegments,
    };
  }

  /**
   * Deletes a segment by ID from both temporal and correlation lists.
   *
   * @param segmentId The ID of the segment to delete.
   */
  public deleteSegment(segmentId: string): void {
    const timer = this.segmentThumbnailDebounceTimers.get(segmentId);
    if (timer) {
      clearTimeout(timer);
      this.segmentThumbnailDebounceTimers.delete(segmentId);
    }
    const sub = this.segmentThumbnailSubscriptions.get(segmentId);
    if (sub) {
      sub.unsubscribe();
      this.segmentThumbnailSubscriptions.delete(segmentId);
    }
    this.thumbnailService.freeSegmentThumbnail(segmentId);
    const currentSegments = this.segments();
    const updated = currentSegments.filter((seg) => seg.id !== segmentId);
    this.segments.set(updated);
    this.correlationOrder.update((order) => order.filter((id) => id !== segmentId));
  }

  /**
   * Updates the start timestamp of a segment, clamping within valid non-overlapping bounds.
   *
   * @param segmentId The ID of the segment.
   * @param newStartTime The requested new start timestamp in seconds.
   */
  public updateSegmentStart(segmentId: string, newStartTime: number): void {
    const currentSegments = this.segments();
    const segment = currentSegments.find((seg) => seg.id === segmentId);
    if (!segment) {
      return;
    }

    const fileSegments = currentSegments
      .filter((seg) => seg.fileId === segment.fileId && seg.id !== segmentId)
      .sort((a, b) => a.startTime - b.startTime);

    const prevSegment = fileSegments
      .filter((seg) => seg.endTime <= segment.startTime)
      .pop();

    const minAllowedStart = prevSegment ? prevSegment.endTime : 0;
    const maxAllowedStart = segment.endTime - VideoSegmentationService.MIN_SEGMENT_DURATION_OFFSET;
    const clampedStart = Math.max(minAllowedStart, Math.min(maxAllowedStart, newStartTime));

    const mediaFile = this.mediaFilesService.mediaFiles().find((f) => f.id === segment.fileId);
    const fileName = mediaFile?.name ?? 'Vídeo';

    const updated = currentSegments.map((seg) => {
      if (seg.id === segmentId) {
        return {
          ...seg,
          startTime: clampedStart,
          name: this.formatSegmentName(fileName, clampedStart, seg.endTime),
        };
      }
      return seg;
    });

    this.sortSegmentsTemporally(updated);
    this.segments.set(updated);

    const existingTimer = this.segmentThumbnailDebounceTimers.get(segmentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.segmentThumbnailDebounceTimers.delete(segmentId);
      this.requestSegmentThumbnail(segmentId);
    }, VideoSegmentationService.THUMBNAIL_DEBOUNCE_TIME_MS);
    this.segmentThumbnailDebounceTimers.set(segmentId, timer);
  }

  /**
   * Requests or refreshes thumbnail generation for a specific segment at its current startTime.
   *
   * @param segmentId The ID of the segment.
   */
  public requestSegmentThumbnail(segmentId: string): void {
    const timer = this.segmentThumbnailDebounceTimers.get(segmentId);
    if (timer) {
      clearTimeout(timer);
      this.segmentThumbnailDebounceTimers.delete(segmentId);
    }

    const existingSub = this.segmentThumbnailSubscriptions.get(segmentId);
    if (existingSub) {
      existingSub.unsubscribe();
      this.segmentThumbnailSubscriptions.delete(segmentId);
    }

    const segment = this.segments().find((s) => s.id === segmentId);
    if (!segment || !segment.id) {
      return;
    }

    const mediaFile = this.mediaFilesService.mediaFiles().find((f) => f.id === segment.fileId);
    if (!mediaFile) {
      return;
    }

    const sub = this.thumbnailService.generateSegmentThumbnailUrls([{
      segmentId: segment.id,
      mediaFileId: segment.fileId,
      file: mediaFile.file,
      startTime: segment.startTime,
    }]).subscribe({
      next: (res) => {
        if ('thumbnailUrl' in res) {
          this.segments.update((segs) => {
            return segs.map((s) => (s.id === res.segmentId ? { ...s, thumbnail: res.thumbnailUrl } : s));
          });
        }
      },
      error: () => {
        this.segmentThumbnailSubscriptions.delete(segmentId);
      },
      complete: () => {
        this.segmentThumbnailSubscriptions.delete(segmentId);
      },
    });

    this.segmentThumbnailSubscriptions.set(segmentId, sub);
  }

  /**
   * Updates the end timestamp of a segment, clamping within valid non-overlapping bounds.
   *
   * @param segmentId The ID of the segment.
   * @param newEndTime The requested new end timestamp in seconds.
   */
  public updateSegmentEnd(segmentId: string, newEndTime: number): void {
    const currentSegments = this.segments();
    const segment = currentSegments.find((seg) => seg.id === segmentId);
    if (!segment) {
      return;
    }

    const fileSegments = currentSegments
      .filter((seg) => seg.fileId === segment.fileId && seg.id !== segmentId)
      .sort((a, b) => a.startTime - b.startTime);

    const nextSegment = fileSegments
      .find((seg) => seg.startTime >= segment.endTime);

    const duration = this.fileDurations.get(segment.fileId) ?? segment.endTime;
    const maxAllowedEnd = nextSegment ? nextSegment.startTime : duration;
    const minAllowedEnd = segment.startTime + VideoSegmentationService.MIN_SEGMENT_DURATION_OFFSET;
    const clampedEnd = Math.max(minAllowedEnd, Math.min(maxAllowedEnd, newEndTime));

    const mediaFile = this.mediaFilesService.mediaFiles().find((f) => f.id === segment.fileId);
    const fileName = mediaFile?.name ?? 'Vídeo';

    const updated = currentSegments.map((seg) => {
      if (seg.id === segmentId) {
        return {
          ...seg,
          endTime: clampedEnd,
          name: this.formatSegmentName(fileName, seg.startTime, clampedEnd),
        };
      }
      return seg;
    });

    this.sortSegmentsTemporally(updated);
    this.segments.set(updated);
  }

  /**
   * Moves a segment up by one index in the correlation order.
   *
   * @param index The index in the correlation list to move up.
   */
  public moveSegmentUp(index: number): void {
    const correlated = this.correlatedSegments();
    if (index <= 0 || index >= correlated.length) {
      return;
    }

    const currentOrder = correlated.map((seg) => seg.id!).filter(Boolean);
    [currentOrder[index - 1], currentOrder[index]] = [currentOrder[index], currentOrder[index - 1]];
    this.correlationOrder.set(currentOrder);
  }

  /**
   * Moves a segment down by one index in the correlation order.
   *
   * @param index The index in the correlation list to move down.
   */
  public moveSegmentDown(index: number): void {
    const correlated = this.correlatedSegments();
    if (index < 0 || index >= correlated.length - 1) {
      return;
    }

    const currentOrder = correlated.map((seg) => seg.id!).filter(Boolean);
    [currentOrder[index], currentOrder[index + 1]] = [currentOrder[index + 1], currentOrder[index]];
    this.correlationOrder.set(currentOrder);
  }

  /**
   * Synchronizes internal video segments with current media files from MediaFiles service.
   *
   * @param mediaFiles The current list of media files.
   */
  private async syncSegmentsWithMediaFiles(mediaFiles: readonly MediaFile[]): Promise<void> {
    const currentFileIds = new Set(mediaFiles.map((f) => f.id));
    const addedFiles = mediaFiles.filter((f) => !this.lastKnownFileIds.has(f.id));
    const removedFileIds = [...this.lastKnownFileIds].filter((id) => !currentFileIds.has(id));

    this.lastKnownFileIds = new Set(currentFileIds);

    if (removedFileIds.length > 0) {
      for (const id of removedFileIds) {
        this.fileDurations.delete(id);
        this.fileFps.delete(id);
        this.thumbnailService.freeSegmentThumbnailsForFile(id);
        this.thumbnailService.freeFilmstripThumbnailsForFile(id);
        for (const seg of this.segments()) {
          if (seg.fileId === id && seg.id) {
            const sub = this.segmentThumbnailSubscriptions.get(seg.id);
            if (sub) {
              sub.unsubscribe();
              this.segmentThumbnailSubscriptions.delete(seg.id);
            }
          }
        }
      }
      const updated = this.segments().filter((seg) => !removedFileIds.includes(seg.fileId));
      this.segments.set(updated);
      this.correlationOrder.update((order) => order.filter((id) => updated.some((s) => s.id === id)));
    }

    if (addedFiles.length > 0) {
      for (const mediaFile of addedFiles) {
        await this.inspectVideoFile(mediaFile);
      }

      const existingSegments = this.segments();
      const newSegments: VideoSegment[] = [];

      for (const mediaFile of addedFiles) {
        const alreadyHasSegment = existingSegments.some((s) => s.fileId === mediaFile.id);
        if (!alreadyHasSegment) {
          const duration = this.fileDurations.get(mediaFile.id) ?? 0;
          const segmentId = this.createSegmentId();
          newSegments.push({
            id: segmentId,
            fileId: mediaFile.id,
            name: this.formatSegmentName(mediaFile.name, 0, duration),
            startTime: 0,
            endTime: duration,
            thumbnail: null,
          });
        }
      }

      if (newSegments.length > 0) {
        const updated = [...existingSegments, ...newSegments];
        this.sortSegmentsTemporally(updated);
        this.segments.set(updated);
        this.correlationOrder.update((order) => [...order, ...newSegments.map((s) => s.id!)]);

        const thumbnailRequests: SegmentThumbnailGenerationRequest[] = [];
        for (const seg of newSegments) {
          const mf = mediaFiles.find((f) => f.id === seg.fileId);
          if (mf && seg.id) {
            thumbnailRequests.push({
              segmentId: seg.id,
              mediaFileId: seg.fileId,
              file: mf.file,
              startTime: seg.startTime,
            });
          }
        }

        if (thumbnailRequests.length > 0) {
          this.thumbnailService.generateSegmentThumbnailUrls(thumbnailRequests).subscribe({
            next: (res) => {
              if ('thumbnailUrl' in res) {
                this.segments.update((segs) => {
                  return segs.map((s) => (s.id === res.segmentId ? { ...s, thumbnail: res.thumbnailUrl } : s));
                });
              }
            },
          });
        }
      }
    }
  }

  /**
   * Sets duration and fps for a media file, useful for tests or manual overrides.
   *
   * @param fileId The media file ID.
   * @param duration The duration in seconds.
   * @param fps The frames per second, defaulting to DEFAULT_FPS.
   */
  public setFileMetrics(fileId: MediaFileId, duration: number, fps = VideoSegmentationService.DEFAULT_FPS): void {
    this.fileDurations.set(fileId, duration);
    this.fileFps.set(fileId, fps);
  }

  /**
   * Inspects a video file using Mediabunny to determine its duration and frame rate metrics.
   *
   * @param mediaFile The media file to inspect.
   */
  private async inspectVideoFile(mediaFile: MediaFile): Promise<void> {
    const input = new Input({
      source: new BlobSource(mediaFile.file),
      formats: ALL_FORMATS,
    });

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (videoTrack) {
        const firstTimestamp = (await videoTrack.getFirstTimestamp()) ?? 0;
        const lastTimestamp = (await videoTrack.computeDuration()) ?? 0;
        const duration = Math.max(0, lastTimestamp - firstTimestamp);
        this.fileDurations.set(mediaFile.id, duration);

        try {
          const metrics = await videoTrack.computeFrameRateMetrics();
          const fps = metrics.bestGuessFrameRate || metrics.averageFrameRate;
          if (fps && fps > 0) {
            this.fileFps.set(mediaFile.id, fps);
          }
        } catch (_e) {
          this.fileFps.set(mediaFile.id, VideoSegmentationService.DEFAULT_FPS);
        }
      }
    } catch (_e) {
      if (!this.fileDurations.has(mediaFile.id)) {
        this.fileDurations.set(mediaFile.id, 0);
      }
      if (!this.fileFps.has(mediaFile.id)) {
        this.fileFps.set(mediaFile.id, VideoSegmentationService.DEFAULT_FPS);
      }
    } finally {
      input.dispose();
    }
  }

  /**
   * Sorts an array of segments in strict temporal order.
   *
   * @param segments The array of segments to sort in-place.
   */
  private sortSegmentsTemporally(segments: VideoSegment[]): void {
    const mediaFiles = this.mediaFilesService.mediaFiles();
    const fileOrderMap = new Map<MediaFileId, number>();
    mediaFiles.forEach((file, index) => {
      fileOrderMap.set(file.id, index);
    });

    segments.sort((a, b) => {
      const fileOrderA = fileOrderMap.get(a.fileId) ?? VideoSegmentationService.FALLBACK_FILE_ORDER_INDEX;
      const fileOrderB = fileOrderMap.get(b.fileId) ?? VideoSegmentationService.FALLBACK_FILE_ORDER_INDEX;
      if (fileOrderA !== fileOrderB) {
        return fileOrderA - fileOrderB;
      }
      return a.startTime - b.startTime;
    });
  }

  /**
   * Restores video segments and correlation order to a specified snapshot state.
   * Cleans up pending debounce timers for removed segments and requests thumbnails for restored segments.
   *
   * @param segments The video segments snapshot to restore.
   * @param correlationOrder The correlation order snapshot to restore.
   */
  public restoreSegmentationState(
    segments: readonly VideoSegment[],
    correlationOrder: readonly string[]
  ): void {
    const oldSegmentIds = new Set(
      this.segments()
        .map((s) => s.id)
        .filter(Boolean)
    );
    const newSegmentIds = new Set(
      segments
        .map((s) => s.id)
        .filter(Boolean)
    );

    for (const id of oldSegmentIds) {
      if (!newSegmentIds.has(id)) {
        const timer = this.segmentThumbnailDebounceTimers.get(id!);
        if (timer) {
          clearTimeout(timer);
          this.segmentThumbnailDebounceTimers.delete(id!);
        }
        const sub = this.segmentThumbnailSubscriptions.get(id!);
        if (sub) {
          sub.unsubscribe();
          this.segmentThumbnailSubscriptions.delete(id!);
        }
        this.thumbnailService?.freeSegmentThumbnail?.(id!);
      }
    }

    const currentSegmentMap = new Map(this.segments().map((s) => [s.id, s]));
    const cloned: VideoSegment[] = segments.map((seg) => {
      const live = seg.id ? currentSegmentMap.get(seg.id) : undefined;
      return {
        ...seg,
        thumbnail: live?.thumbnail ?? null,
      };
    });

    this.sortSegmentsTemporally(cloned);
    this.segments.set(cloned);
    this.correlationOrder.set([...correlationOrder]);

    for (const seg of cloned) {
      if (seg.id && !seg.thumbnail) {
        this.requestSegmentThumbnail(seg.id);
      }
    }
  }

  /**
   * Restores the correlation order array.
   *
   * @param correlationOrder The correlation order array to restore.
   */
  public restoreCorrelationOrder(correlationOrder: readonly string[]): void {
    this.correlationOrder.set([...correlationOrder]);
  }

  /**
   * Creates a unique ID for a video segment.
   *
   * @returns The generated segment ID.
   */
  private createSegmentId(): string {
    const randomSuffix = Math.random().toString(36);
    return `seg-${Date.now()}-${randomSuffix.slice(2, 8)}`;
  }
}

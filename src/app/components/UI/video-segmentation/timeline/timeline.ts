import {
  Component,
  inject,
  model,
  signal,
  computed,
  effect,
  untracked,
  ElementRef,
  viewChild,
  OnDestroy,
  AfterViewInit,
  Renderer2
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MediaFiles, type MediaFileId, type MediaFile } from '../../../../services/media-files/media-files';
import {
  VideoSegmentationService,
  type VideoSegment
} from '../../../../services/video-segmentation/video-segmentation';
import {
  Thumbnail,
  type FilmstripThumbnailResult,
  type FilmstripFileSection,
} from '../../../../services/thumbnail/thumbnail';
import { Subscription } from 'rxjs';
import { AutoSegmentationService } from '../../../../services/auto-segmentation/auto-segmentation';
import { UndoRedoService } from '../../../../services/undo/undo-redo';
import {
  SplitSegmentCommand,
  JoinSegmentsCommand,
  DeleteSegmentCommand,
  UpdateSegmentBoundaryCommand,
} from '../../../../services/undo/commands/video-segmentation-commands';

export interface ThumbnailSlot {
  index: number,
  timestamp: number,
  left: number,
  width: number,
  key: string,
}

export interface UnsegmentedInterval {
  start: number,
  end: number,
}

export type TimelineTrackItem =
  { type: 'gap', index: number, start: number, end: number, key: string } |
  { type: 'segment', segment: VideoSegment, key: string };

/**
 * Component representing the video filmstrip viewer, cutter timeline, and ruler.
 */
@Component({
  selector: 'app-timeline',
  imports: [CommonModule],
  templateUrl: './timeline.html',
  styleUrl: './timeline.scss',
})
export class Timeline implements OnDestroy, AfterViewInit {
  protected readonly mediaFilesService = inject(MediaFiles);
  protected readonly videoSegmentationService = inject(VideoSegmentationService);
  protected readonly autoSegmentationService = inject(AutoSegmentationService);
  private readonly thumbnailService = inject(Thumbnail);
  private readonly undoRedoService = inject(UndoRedoService);
  private readonly renderer = inject(Renderer2);

  public readonly currentTime = model<number>(0);
  public readonly activeMediaFileId = model<MediaFileId | null>(null);
  public readonly isPlaying = model<boolean>(false);
  public readonly isScrubbing = model<boolean>(false);
  public readonly isMagicPanelOpen = signal<boolean>(false);

  public readonly pixelsPerSecond = signal<number>(50);
  public readonly filmstripBodyHeight = signal<number>(80);
  public readonly trackScrollLeft = signal<number>(0);
  public readonly trackViewportWidth = signal<number>(800);

  protected readonly trackContainer = viewChild<ElementRef<HTMLDivElement>>('trackContainer');
  protected readonly timelineContainer = viewChild<ElementRef<HTMLDivElement>>('timelineContainer');

  private readonly thumbnailsMap = signal<Map<string, Map<number, string>>>(new Map());
  private readonly thumbnailSlotsCache = new Map<string, ThumbnailSlot[]>();
  private thumbnailSubscription: Subscription | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private zoomDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestedZoomInterval: number | null = null;

  private isDraggingPlayhead = false;
  private activeTabDrag: {
    segmentId: string,
    edge: 'start' | 'end',
    startX: number,
    initialTime: number,
    initialSegments: VideoSegment[],
    initialOrder: string[],
  } | null = null;

  protected readonly isGhostPreview = signal<boolean>(false);
  protected readonly ghostPlayheadTime = signal<number | null>(null);
  protected readonly ghostPlayheadFileId = signal<MediaFileId | null>(null);
  private justFinishedTabInteraction = false;
  private tabKeyGhostTimer: ReturnType<typeof setTimeout> | null = null;
  private trackKeyScrubTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFocusedEntityId: string | null = null;
  private lambdaRafId: number | null = null;
  private pendingLambdaValue: number | null = null;
  private pendingLambdaFileId: MediaFileId | null = null;
  private isRecalculatingLambda = false;

  private unlistenMouseMove: (() => void) | null = null;
  private unlistenMouseUp: (() => void) | null = null;

  private static readonly MIN_PIXELS_PER_SECOND = 0.1;
  private static readonly MAX_PIXELS_PER_SECOND = 1000;
  private static readonly FILMSTRIP_GAP = 8 * (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  private static readonly TAB_KEY_GHOST_TIME_MS = 600;
  private static readonly TRACK_KEY_SCRUB_TIME_MS = 300;
  private static readonly ZOOM_DEBOUNCE_TIME_MS = 150;
  private static readonly SCROLL_DEBOUNCE_TIME_MS = 100;
  private static readonly JUST_FINISHED_ACTION_TIME_MS = 100;
  private static readonly CTRL_PLUS_MINUS_ZOOM_FACTOR = 1.25;
  private static readonly CTRL_SCROLL_ZOOM_FACTOR = 1.15;
  private static readonly FILMSTRIP_THUMBNAIL_BUFFER = 10;
  private static readonly DEFAULT_FPS = 30;
  private static readonly DEFAULT_FALLBACK_DURATION = 10;
  private static readonly FILMSTRIP_START_PADDING_PX = 16;
  private static readonly MIN_FILMSTRIP_WIDTH_PX = 20;
  private static readonly DEFAULT_VIEWPORT_WIDTH_PX = 800;
  private static readonly TRACK_END_PADDING_PX = 64;
  private static readonly CHROME_HEIGHT_OFFSET_PX = 84;
  private static readonly MIN_BODY_HEIGHT_PX = 30;
  private static readonly MIN_BODY_HEIGHT_FOR_THUMBNAILS = 20;
  private static readonly THUMBNAIL_ASPECT_RATIO = 16 / 9;
  private static readonly MIN_TIME_BETWEEN_THUMBNAILS = 0.1;
  private static readonly ZOOM_INTERVAL_TOLERANCE = 0.001;
  private static readonly THUMBNAIL_MATCH_TOLERANCE = 0.08;
  private static readonly AUTOPAN_MARGIN_PX = 80;
  private static readonly BOUNDARY_SNAP_THRESHOLD = 0.05;

  /**
   * Computed list of media files currently loaded.
   */
  protected readonly mediaFiles = computed(() => this.mediaFilesService.mediaFiles());

  /**
   * Computed active media file.
   */
  protected readonly activeMediaFile = computed<MediaFile | null>(() => {
    const files = this.mediaFiles();
    const id = this.activeMediaFileId();
    if (!id && files.length > 0) {
      return files[0];
    }
    return files.find((f) => f.id === id) ?? null;
  });

  /**
   * Computed duration of the active media file.
   */
  protected readonly activeFileDuration = computed<number>(() => {
    const active = this.activeMediaFile();
    if (!active) {
      return 0;
    }
    return this.videoSegmentationService.getFileDuration(active.id) ?? 0;
  });

  /**
   * Computed active segment corresponding to the current playhead position and active file.
   */
  public readonly activeSegment = computed<VideoSegment | null>(() => {
    const active = this.activeMediaFile();
    if (!active) {
      return null;
    }
    return this.videoSegmentationService.findSegmentAtTime(active.id, this.currentTime());
  });

  /**
   * Computed state of the cut button: 'split' when inside a splittable segment,
   * 'create' when in an unsegmented gap where a segment can be created,
   * or 'disabled' when neither action is possible.
   */
  public readonly cutButtonState = computed<'split' | 'create' | 'disabled'>(() => {
    const active = this.activeMediaFile();
    if (!active) {
      return 'disabled';
    }
    this.videoSegmentationService.segments();
    const time = this.currentTime();
    if (this.videoSegmentationService.canSplitSegment(active.id, time)) {
      return 'split';
    }
    if (this.videoSegmentationService.canCreateSegmentInGap(active.id, time)) {
      return 'create';
    }
    return 'disabled';
  });

  /**
   * Computed accessible label for the cut toolbar button based on its current action.
   */
  public readonly cutButtonAriaLabel = computed<string>(() => {
    return this.cutButtonState() === 'create'
      ? 'Criar segmento na posição do cursor (K)'
      : 'Dividir segmento na posição do cursor (K)';
  });

  /**
   * Computed tooltip title for the cut toolbar button based on its current action.
   */
  public readonly cutButtonTitle = computed<string>(() => {
    return this.cutButtonState() === 'create'
      ? 'Criar segmento (K)'
      : 'Dividir segmento (K)';
  });

  /**
   * Computed flag indicating whether two segments can be joined at the current playhead position.
   */
  public readonly canJoinAtPlayhead = computed<boolean>(() => {
    const active = this.activeMediaFile();
    if (!active) {
      return false;
    }
    this.videoSegmentationService.segments();
    return this.videoSegmentationService.canJoinSegments(active.id, this.currentTime());
  });

  /**
   * Computed flag indicating whether the active or focused segment can be deleted.
   */
  public readonly canDeleteAtPlayhead = computed<boolean>(() => {
    return this.activeSegment() !== null;
  });

  /**
   * Computed layout metrics for all filmstrips.
   */
  protected readonly filmstripLayouts = computed(() => {
    const files = this.mediaFiles();
    const pps = this.pixelsPerSecond();
    let currentLeft = Timeline.FILMSTRIP_START_PADDING_PX;

    return files.map((file) => {
      const duration = this.videoSegmentationService.getFileDuration(file.id) ?? Timeline.DEFAULT_FALLBACK_DURATION;
      const width = Math.max(Timeline.MIN_FILMSTRIP_WIDTH_PX, duration * pps);
      const layout = {
        file,
        duration,
        left: currentLeft,
        width,
      };
      currentLeft += width + Timeline.FILMSTRIP_GAP;
      return layout;
    });
  });

  /**
   * Total width of the timeline scrollable track, taking at least the viewport width.
   */
  protected readonly totalTrackWidth = computed(() => {
    const layouts = this.filmstripLayouts();
    const viewportWidth = this.trackViewportWidth();
    if (layouts.length === 0) {
      return viewportWidth > 0 ? viewportWidth : Timeline.DEFAULT_VIEWPORT_WIDTH_PX;
    }
    const last = layouts[layouts.length - 1];
    const contentWidth = last.left + last.width + Timeline.TRACK_END_PADDING_PX;
    return Math.max(viewportWidth, contentWidth);
  });

  /**
   * Absolute left position of the playhead on the track in pixels.
   */
  protected readonly playheadPixelLeft = computed(() => {
    const isGhost = this.isGhostPreview();
    const activeId = isGhost && this.ghostPlayheadFileId()
      ? this.ghostPlayheadFileId()
      : this.activeMediaFileId();
    const time = isGhost && this.ghostPlayheadTime() !== null
      ? this.ghostPlayheadTime()!
      : this.currentTime();
    const layouts = this.filmstripLayouts();
    const targetLayout = layouts.find((l) => l.file.id === activeId) ?? layouts[0];

    if (!targetLayout) {
      return Timeline.FILMSTRIP_START_PADDING_PX;
    }

    return targetLayout.left + (time * this.pixelsPerSecond());
  });

  constructor() {
    effect(() => {
      const files = this.mediaFiles();
      const currentActiveId = untracked(() => this.activeMediaFileId());

      if (files.length > 0 && (!currentActiveId || !files.some((f) => f.id === currentActiveId))) {
        this.activeMediaFileId.set(files[0].id);
      }
    });

    effect(() => {
      const activeFile = this.activeMediaFile();
      this.currentTime();
      const playing = this.isPlaying();

      untracked(() => {
        if (playing && activeFile) {
          this.autoPanToPlayhead();
          this.updateFocusForPlayhead(false);
        }
      });
    });

    effect(() => {
      const files = this.mediaFiles();
      const pps = this.pixelsPerSecond();
      const height = this.filmstripBodyHeight();
      this.trackViewportWidth();

      untracked(() => {
        if (files.length > 0 && height > Timeline.MIN_BODY_HEIGHT_FOR_THUMBNAILS) {
          this.scheduleZoomThumbnailRequest(files, pps, height);
        }
      });
    });
  }

  ngAfterViewInit(): void {
    const track = this.trackContainer()?.nativeElement;
    if (track) {
      const initialClientWidth = track.clientWidth;
      if (initialClientWidth > 0) {
        this.trackViewportWidth.set(initialClientWidth);
      }
      this.trackScrollLeft.set(track.scrollLeft);

      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const height = entry.contentRect.height;
            const width = entry.contentRect.width;

            if (width > 0 && Math.abs(width - this.trackViewportWidth()) > 2) {
              this.trackViewportWidth.set(Math.round(width));
            }

            // Allocate space for guide lines (2rem top + 1.5rem bottom), filmstrip header (1.5rem), bottom border (4px)
            const availableBodyHeight = Math.max(
              Timeline.MIN_BODY_HEIGHT_PX,
              Math.round(height - Timeline.CHROME_HEIGHT_OFFSET_PX)
            );
            if (Math.abs(availableBodyHeight - this.filmstripBodyHeight()) > 2) {
              this.filmstripBodyHeight.set(availableBodyHeight);
            }
          }
        });
        this.resizeObserver.observe(track);
      }

      const initialHeight = track.clientHeight;
      if (initialHeight > 0) {
        const availableBodyHeight = Math.max(
          Timeline.MIN_BODY_HEIGHT_PX,
          Math.round(initialHeight - Timeline.CHROME_HEIGHT_OFFSET_PX)
        );
        this.filmstripBodyHeight.set(availableBodyHeight);
      }
    }
  }

  ngOnDestroy(): void {
    if (this.zoomDebounceTimer) {
      clearTimeout(this.zoomDebounceTimer);
      this.zoomDebounceTimer = null;
    }
    if (this.scrollDebounceTimer) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }
    this.thumbnailSubscription?.unsubscribe();
    this.thumbnailService?.freeAllFilmstripThumbnails?.();
    this.thumbnailsMap.set(new Map());
    this.thumbnailSlotsCache.clear();
    this.resizeObserver?.disconnect();
    if (this.tabKeyGhostTimer) {
      clearTimeout(this.tabKeyGhostTimer);
      this.tabKeyGhostTimer = null;
    }
    if (this.trackKeyScrubTimer) {
      clearTimeout(this.trackKeyScrubTimer);
      this.trackKeyScrubTimer = null;
    }
    this.cancelPendingLambdaRecalculation();
    this.cleanupMouseListeners();
  }

  /**
   * Handles scroll events on the timeline track container with debouncing.
   */
  public onTrackScroll(): void {
    const track = this.trackContainer()?.nativeElement;
    if (!track) {
      return;
    }
    this.trackScrollLeft.set(track.scrollLeft);

    if (this.zoomDebounceTimer) {
      return;
    }

    if (this.scrollDebounceTimer) {
      clearTimeout(this.scrollDebounceTimer);
    }
    this.scrollDebounceTimer = setTimeout(() => {
      this.scrollDebounceTimer = null;
      const files = this.mediaFiles();
      const pps = this.pixelsPerSecond();
      const height = this.filmstripBodyHeight();
      if (files.length > 0 && height > Timeline.MIN_BODY_HEIGHT_FOR_THUMBNAILS) {
        this.requestFilmstripThumbnails(files, pps, height);
      }
    }, Timeline.SCROLL_DEBOUNCE_TIME_MS);
  }

  /**
   * Schedules a debounced filmstrip thumbnail request after zoom or container resize events settle.
   */
  private scheduleZoomThumbnailRequest(files: readonly MediaFile[], pps: number, bodyHeight: number): void {
    if (this.scrollDebounceTimer) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }
    if (this.zoomDebounceTimer) {
      clearTimeout(this.zoomDebounceTimer);
    }
    this.zoomDebounceTimer = setTimeout(() => {
      this.zoomDebounceTimer = null;
      this.requestFilmstripThumbnails(files, pps, bodyHeight);
    }, Timeline.ZOOM_DEBOUNCE_TIME_MS);
  }

  /**
   * Requests filmstrip thumbnail streaming from the Thumbnail service.
   * Uses a two-stage approach: Stage 1 requests thumbnails for the visible viewport for immediate rendering;
   * on completion, Stage 2 requests the wider buffered range in the background.
   */
  private requestFilmstripThumbnails(files: readonly MediaFile[], pps: number, bodyHeight: number): void {
    if (this.zoomDebounceTimer) {
      clearTimeout(this.zoomDebounceTimer);
      this.zoomDebounceTimer = null;
    }
    if (this.scrollDebounceTimer) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }

    const aspect = Timeline.THUMBNAIL_ASPECT_RATIO;
    const thumbWidth = bodyHeight * aspect;
    const timeBetweenThumbnails = Math.max(Timeline.MIN_TIME_BETWEEN_THUMBNAILS, thumbWidth / pps);

    const isSameZoom = this.lastRequestedZoomInterval !== null &&
      Math.abs(timeBetweenThumbnails - this.lastRequestedZoomInterval) <= Timeline.ZOOM_INTERVAL_TOLERANCE;

    if (!isSameZoom) {
      this.thumbnailsMap.set(new Map());
      this.lastRequestedZoomInterval = timeBetweenThumbnails;
    }

    this.thumbnailSubscription?.unsubscribe();

    const track = this.trackContainer()?.nativeElement;
    if (track && track.scrollLeft > 0 && track.scrollLeft !== this.trackScrollLeft()) {
      this.trackScrollLeft.set(track.scrollLeft);
    }
    if (track && track.clientWidth > 0 && track.clientWidth !== this.trackViewportWidth()) {
      this.trackViewportWidth.set(track.clientWidth);
    }

    const scrollLeft = this.trackScrollLeft();
    const viewportWidth = this.trackViewportWidth();

    // Stage 1: Visible viewport range
    const visibleStartPx = Math.max(0, scrollLeft);
    const visibleEndPx = scrollLeft + viewportWidth;
    const visibleSections = this.computeFileSectionsForPixelRange(
      visibleStartPx,
      visibleEndPx,
      pps,
      timeBetweenThumbnails
    );

    // Stage 2: Buffered range (FILMSTRIP_THUMBNAIL_BUFFER viewport widths before and after)
    const buffer = Timeline.FILMSTRIP_THUMBNAIL_BUFFER * viewportWidth;
    const bufferStartPx = Math.max(0, scrollLeft - buffer);
    const bufferEndPx = scrollLeft + viewportWidth + buffer;
    const bufferedSections = this.computeFileSectionsForPixelRange(
      bufferStartPx,
      bufferEndPx,
      pps,
      timeBetweenThumbnails
    );

    if (visibleSections.length === 0) {
      if (bufferedSections.length === 0) {
        this.thumbnailSubscription = null;
        return;
      }
      this.thumbnailSubscription = this.thumbnailService.generateFilmstripThumbnails({
        timeBetweenThumbnails,
        files: bufferedSections,
        thumbnailSize: Math.round(bodyHeight),
      }).subscribe({
        next: (result: FilmstripThumbnailResult) => {
          this.handleThumbnailResult(result);
        },
      });
      return;
    }

    // Stage 1: Request visible viewport thumbnails first
    this.thumbnailSubscription = this.thumbnailService.generateFilmstripThumbnails({
      timeBetweenThumbnails,
      files: visibleSections,
      thumbnailSize: Math.round(bodyHeight),
    }).subscribe({
      next: (result: FilmstripThumbnailResult) => {
        this.handleThumbnailResult(result);
      },
      complete: () => {
        // Stage 2: Request buffered range in the background
        if (bufferedSections.length > 0) {
          this.thumbnailSubscription = this.thumbnailService.generateFilmstripThumbnails({
            timeBetweenThumbnails,
            files: bufferedSections,
            thumbnailSize: Math.round(bodyHeight),
          }).subscribe({
            next: (result: FilmstripThumbnailResult) => {
              this.handleThumbnailResult(result);
            },
          });
        }
      },
    });
  }

  /**
   * Computes aligned filmstrip file sections intersecting a given pixel range on the timeline track.
   */
  private computeFileSectionsForPixelRange(
    rangeStartPx: number,
    rangeEndPx: number,
    pps: number,
    timeBetweenThumbnails: number
  ): FilmstripFileSection[] {
    const layouts = this.filmstripLayouts();
    const fileSections: FilmstripFileSection[] = [];

    for (const layout of layouts) {
      const fileTrackStart = layout.left;
      const fileTrackEnd = layout.left + layout.width;

      const interStartPx = Math.max(rangeStartPx, fileTrackStart);
      const interEndPx = Math.min(rangeEndPx, fileTrackEnd);

      if (interEndPx > interStartPx) {
        const rawStartTime = Math.max(0, (interStartPx - fileTrackStart) / pps);
        const rawEndTime = Math.min(layout.duration, (interEndPx - fileTrackStart) / pps);

        const startSlotIndex = Math.max(0, Math.floor(rawStartTime / timeBetweenThumbnails));
        const alignedStartTime = startSlotIndex * timeBetweenThumbnails;

        const endSlotIndex = Math.ceil(rawEndTime / timeBetweenThumbnails);
        const alignedEndTime = Math.min(layout.duration, endSlotIndex * timeBetweenThumbnails);

        if (alignedEndTime >= alignedStartTime) {
          fileSections.push({
            mediaFileId: layout.file.id,
            file: layout.file.file,
            startTime: alignedStartTime,
            endTime: alignedEndTime,
          });
        }
      }
    }

    return fileSections;
  }

  /**
   * Processes an incoming filmstrip thumbnail result and updates the thumbnails signal map.
   */
  private handleThumbnailResult(result: FilmstripThumbnailResult): void {
    if ('thumbnailUrl' in result && result.timestamp !== undefined) {
      this.thumbnailsMap.update((map) => {
        const fileMap = map.get(result.mediaFileId) ?? new Map<number, string>();
        fileMap.set(result.timestamp!, result.thumbnailUrl);
        map.set(result.mediaFileId, fileMap);
        return new Map(map);
      });
    }
  }

  /**
   * Calculates thumbnail slots for a given file to fill the filmstrip with zero gaps.
   * Caches results across identical rendering dimensions to avoid allocation churn.
   */
  public getThumbnailSlots(fileId: MediaFileId): ThumbnailSlot[] {
    const duration = this.videoSegmentationService.getFileDuration(fileId) ?? Timeline.DEFAULT_FALLBACK_DURATION;
    const pps = this.pixelsPerSecond();
    const bodyHeight = this.filmstripBodyHeight();
    const cacheKey = `${fileId}_${pps}_${bodyHeight}_${duration}`;
    const cached = this.thumbnailSlotsCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const thumbWidth = bodyHeight * Timeline.THUMBNAIL_ASPECT_RATIO;
    const timeStep = Math.max(Timeline.MIN_TIME_BETWEEN_THUMBNAILS, thumbWidth / pps);

    const slots: ThumbnailSlot[] = [];
    let currentT = 0;
    let index = 0;

    while (currentT <= duration + 1e-4) {
      slots.push({
        index,
        timestamp: currentT,
        left: index * thumbWidth,
        width: thumbWidth,
        key: `${fileId}_${currentT}_${thumbWidth}`,
      });
      currentT += timeStep;
      index++;
    }

    this.thumbnailSlotsCache.set(cacheKey, slots);
    return slots;
  }

  /**
   * Retrieves the thumbnail URL for a given media file and timestamp.
   */
  public getThumbnailUrl(fileId: MediaFileId, timestamp: number): string | null {
    const fileMap = this.thumbnailsMap().get(fileId);
    if (!fileMap) {
      return null;
    }

    let closestUrl: string | null = null;
    let minDiff = Timeline.THUMBNAIL_MATCH_TOLERANCE;

    for (const [t, url] of fileMap.entries()) {
      const diff = Math.abs(t - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closestUrl = url;
      }
    }

    return closestUrl;
  }

  /**
   * Handles thumbnail image loading error by removing the invalid URL from the cache.
   */
  public onThumbnailError(fileId: MediaFileId, timestamp: number): void {
    this.thumbnailsMap.update((map) => {
      const fileMap = map.get(fileId);
      if (!fileMap) {
        return map;
      }
      for (const [t] of fileMap.entries()) {
        if (Math.abs(t - timestamp) < Timeline.THUMBNAIL_MATCH_TOLERANCE) {
          fileMap.delete(t);
        }
      }
      return new Map(map);
    });
  }

  /**
   * Calculates unsegmented intervals for a media file to render the dimmed grayscale overlay.
   */
  public getUnsegmentedIntervals(fileId: MediaFileId): UnsegmentedInterval[] {
    const duration = this.videoSegmentationService.getFileDuration(fileId) ?? 0;
    const segments = this.videoSegmentationService.segments()
      .filter((s) => s.fileId === fileId)
      .sort((a, b) => a.startTime - b.startTime);

    if (segments.length === 0) {
      return [{ start: 0, end: duration }];
    }

    const intervals: UnsegmentedInterval[] = [];
    let cursor = 0;

    for (const seg of segments) {
      if (seg.startTime > cursor) {
        intervals.push({ start: cursor, end: seg.startTime });
      }
      cursor = Math.max(cursor, seg.endTime);
    }

    if (cursor < duration) {
      intervals.push({ start: cursor, end: duration });
    }

    return intervals;
  }

  /**
   * Returns segments belonging to a specific file.
   */
  public getFileSegments(fileId: MediaFileId): VideoSegment[] {
    return this.videoSegmentationService.segments().filter((s) => s.fileId === fileId);
  }

  /**
   * Returns chronologically ordered track items (gaps and segments) for a media file.
   */
  public getTimelineTrackItems(fileId: MediaFileId): TimelineTrackItem[] {
    const duration = this.videoSegmentationService.getFileDuration(fileId) ?? 0;
    const segments = this.videoSegmentationService.segments()
      .filter((s) => s.fileId === fileId)
      .sort((a, b) => a.startTime - b.startTime);

    const items: TimelineTrackItem[] = [];
    let cursor = 0;
    let gapIndex = 0;

    for (const seg of segments) {
      if (seg.startTime > cursor) {
        items.push({
          type: 'gap',
          index: gapIndex++,
          start: cursor,
          end: seg.startTime,
          key: `gap-${fileId}-${gapIndex - 1}`,
        });
      }
      items.push({
        type: 'segment',
        segment: seg,
        key: `segment-${seg.id}`,
      });
      cursor = Math.max(cursor, seg.endTime);
    }

    if (cursor < duration) {
      items.push({
        type: 'gap',
        index: gapIndex++,
        start: cursor,
        end: duration,
        key: `gap-${fileId}-${gapIndex - 1}`,
      });
    }

    return items;
  }

  /**
   * Updates keyboard focus to match the active segment or unsegmented gap at the playhead.
   */
  public updateFocusForPlayhead(force = false): void {
    if (typeof document === 'undefined') {
      return;
    }
    const activeFile = this.activeMediaFile();
    if (!activeFile) {
      return;
    }

    const container = this.timelineContainer()?.nativeElement;
    if (!container) {
      return;
    }

    const activeEl = document.activeElement as HTMLElement | null;
    const isFocusWithin = container.contains(activeEl);

    if (!force && !isFocusWithin) {
      return;
    }

    if (!force && activeEl && activeEl.classList.contains('segment-tab')) {
      return;
    }

    const items = this.getTimelineTrackItems(activeFile.id);
    const curr = this.currentTime();

    let targetItem: TimelineTrackItem | null = null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'segment') {
        const isLast = i === items.length - 1;
        const inBounds = curr >= item.segment.startTime &&
          (curr < item.segment.endTime || (isLast && curr <= item.segment.endTime));
        if (inBounds) {
          targetItem = item;
          break;
        }
      } else {
        const isLast = i === items.length - 1;
        if (curr >= item.start && (curr < item.end || (isLast && curr <= item.end))) {
          targetItem = item;
          break;
        }
      }
    }

    if (!targetItem && items.length > 0) {
      targetItem = items[0];
    }

    if (!targetItem) {
      return;
    }

    const isAtSegmentStart = targetItem.type === 'segment' &&
      Math.abs(curr - targetItem.segment.startTime) <= Timeline.BOUNDARY_SNAP_THRESHOLD;

    let targetElementId: string;
    if (targetItem.type === 'segment') {
      targetElementId = isAtSegmentStart
        ? `segment-start-anchor-${targetItem.segment.id}`
        : `segment-content-${targetItem.segment.id}`;
    } else {
      targetElementId = `gap-${activeFile.id}-${targetItem.index}`;
    }

    const el = container.querySelector<HTMLElement>(`#${targetElementId}`);
    if (!el) {
      return;
    }

    if (activeEl === el) {
      this.lastFocusedEntityId = targetElementId;
      return;
    }

    this.lastFocusedEntityId = targetElementId;
    el.focus({ preventScroll: true });
  }

  /**
   * Checks whether a mouse event occurred over the container's scrollbar area.
   */
  private isMouseEventOnScrollbar(event: MouseEvent): boolean {
    const container = this.trackContainer()?.nativeElement;
    if (!container || container.clientHeight === 0 || container.clientWidth === 0) {
      return false;
    }
    const rect = container.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    const relativeX = event.clientX - rect.left;

    const hasHorizontalScrollbar = container.scrollWidth > container.clientWidth;
    const hasVerticalScrollbar = container.scrollHeight > container.clientHeight;

    const onHorizontalScrollbar = hasHorizontalScrollbar && relativeY >= container.clientHeight;
    const onVerticalScrollbar = hasVerticalScrollbar && relativeX >= container.clientWidth;

    return onHorizontalScrollbar || onVerticalScrollbar;
  }

  /**
   * Handles clicking on the track or ruler to position the playhead.
   */
  public onTrackClick(event: MouseEvent, targetFileId?: MediaFileId): void {
    if (this.activeTabDrag || this.justFinishedTabInteraction || this.isMouseEventOnScrollbar(event)) {
      return;
    }

    this.updatePlayheadFromMouseEvent(event, targetFileId);
  }

  /**
   * Initiates playhead mouse drag and scrubbing from anywhere on the track or filmstrips.
   */
  public onTrackMouseDown(event: MouseEvent, targetFileId?: MediaFileId): void {
    if (
      event.button !== 0 ||
      this.activeTabDrag ||
      this.justFinishedTabInteraction ||
      this.isMouseEventOnScrollbar(event)
    ) {
      return;
    }

    if (this.isGhostPreview()) {
      this.endGhostPreview();
    }

    this.cleanupMouseListeners();

    event.preventDefault();
    this.isDraggingPlayhead = true;
    this.isScrubbing.set(true);

    this.updatePlayheadFromMouseEvent(event, targetFileId);

    this.unlistenMouseMove = this.renderer.listen('window', 'mousemove', (e: MouseEvent) => {
      this.handleTrackDrag(e);
    });

    this.unlistenMouseUp = this.renderer.listen('window', 'mouseup', () => {
      this.isDraggingPlayhead = false;
      this.isScrubbing.set(false);
      this.cleanupMouseListeners();
    });
  }

  /**
   * Handles continuous scrubbing while dragging the mouse across the timeline track.
   */
  private handleTrackDrag(event: MouseEvent): void {
    if (!this.isDraggingPlayhead) {
      return;
    }
    this.updatePlayheadFromMouseEvent(event);
  }

  /**
   * Updates playhead position and active media file based on mouse coordinates.
   */
  private updatePlayheadFromMouseEvent(event: MouseEvent, targetFileId?: MediaFileId): void {
    const container = this.trackContainer()?.nativeElement;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left + container.scrollLeft;

    const layouts = this.filmstripLayouts();
    if (layouts.length === 0) {
      return;
    }

    let targetLayout = targetFileId ? layouts.find((l) => l.file.id === targetFileId) : null;

    if (!targetLayout) {
      if (mouseX <= layouts[0].left) {
        targetLayout = layouts[0];
      } else if (mouseX >= layouts[layouts.length - 1].left + layouts[layouts.length - 1].width) {
        targetLayout = layouts[layouts.length - 1];
      } else {
        for (let i = 0; i < layouts.length; i++) {
          const current = layouts[i];
          const next = layouts[i + 1];
          if (!next) {
            targetLayout = current;
            break;
          }

          const boundary = (current.left + current.width + next.left) / 2;
          if (mouseX < boundary) {
            targetLayout = current;
            break;
          }
        }
      }
    }

    if (!targetLayout) {
      targetLayout = layouts[0];
    }

    const relativeX = Math.max(0, Math.min(targetLayout.width, mouseX - targetLayout.left));
    const targetTime = relativeX / this.pixelsPerSecond();

    if (this.activeMediaFileId() !== targetLayout.file.id) {
      this.activeMediaFileId.set(targetLayout.file.id);
    }
    this.currentTime.set(targetTime);
    this.updateFocusForPlayhead(true);
  }

  /**
   * Handles mousedown on a segment body to focus the segment and enable scrubbing.
   */
  public onSegmentMouseDown(event: MouseEvent, segment: VideoSegment): void {
    event.stopPropagation();
    this.onTrackMouseDown(event, segment.fileId);
    this.updateFocusForPlayhead(true);
  }

  /**
   * Starts a ghost video preview session during segment tab dragging or keyboard adjustment.
   */
  private startGhostPreview(segmentFileId: MediaFileId, initialTime: number): void {
    if (!this.isGhostPreview()) {
      this.ghostPlayheadTime.set(this.currentTime());
      this.ghostPlayheadFileId.set(this.activeMediaFileId());
      this.isGhostPreview.set(true);
    }
    this.isScrubbing.set(true);
    if (this.activeMediaFileId() !== segmentFileId) {
      this.activeMediaFileId.set(segmentFileId);
    }
    this.currentTime.set(initialTime);
  }

  /**
   * Ends the ghost video preview session and restores playhead position and active file.
   */
  private endGhostPreview(): void {
    if (this.tabKeyGhostTimer) {
      clearTimeout(this.tabKeyGhostTimer);
      this.tabKeyGhostTimer = null;
    }
    if (this.isGhostPreview()) {
      const savedTime = this.ghostPlayheadTime();
      const savedFileId = this.ghostPlayheadFileId();
      if (savedTime !== null) {
        this.currentTime.set(savedTime);
      }
      if (savedFileId !== null) {
        this.activeMediaFileId.set(savedFileId);
      }
      this.isGhostPreview.set(false);
      this.ghostPlayheadTime.set(null);
      this.ghostPlayheadFileId.set(null);
    }
    this.isScrubbing.set(false);
  }

  /**
   * Handles blur events on a segment tab to end keyboard-driven ghost preview.
   *
   * @param segment The optional segment whose tab was blurred.
   * @param edge The edge of the tab ('start' or 'end').
   */
  public onTabBlur(segment?: VideoSegment, edge?: 'start' | 'end'): void {
    if (this.tabKeyGhostTimer) {
      clearTimeout(this.tabKeyGhostTimer);
      this.tabKeyGhostTimer = null;
    }
    if (segment?.id && edge === 'start') {
      this.videoSegmentationService.requestSegmentThumbnail(segment.id);
    }
    if (this.isGhostPreview() && !this.activeTabDrag) {
      this.endGhostPreview();
    }
  }

  /**
   * Initiates segment tab dragging.
   */
  public onTabMouseDown(event: MouseEvent, segment: VideoSegment, edge: 'start' | 'end'): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.cleanupMouseListeners();

    const initialTime = edge === 'start' ? segment.startTime : segment.endTime;
    this.startGhostPreview(segment.fileId, initialTime);

    const initialSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
    const initialOrder = [...this.getCorrelationOrder()];

    this.activeTabDrag = {
      segmentId: segment.id!,
      edge,
      startX: event.clientX,
      initialTime,
      initialSegments,
      initialOrder,
    };

    this.unlistenMouseMove = this.renderer.listen('window', 'mousemove', (e: MouseEvent) => {
      if (!this.activeTabDrag) {
        return;
      }
      const deltaX = e.clientX - this.activeTabDrag.startX;
      const deltaTime = deltaX / this.pixelsPerSecond();
      const newTime = this.activeTabDrag.initialTime + deltaTime;

      if (this.activeTabDrag.edge === 'start') {
        this.videoSegmentationService.updateSegmentStart(this.activeTabDrag.segmentId, newTime);
      } else {
        this.videoSegmentationService.updateSegmentEnd(this.activeTabDrag.segmentId, newTime);
      }

      const seg = this.videoSegmentationService.segments()
        .find((s) => s.id === this.activeTabDrag?.segmentId);
      if (seg) {
        this.currentTime.set(this.activeTabDrag.edge === 'start' ? seg.startTime : seg.endTime);
      }
    });

    this.unlistenMouseUp = this.renderer.listen('window', 'mouseup', () => {
      if (this.activeTabDrag) {
        const segId = this.activeTabDrag.segmentId;
        const dragEdge = this.activeTabDrag.edge;
        const initSegs = this.activeTabDrag.initialSegments;
        const initOrder = this.activeTabDrag.initialOrder;
        const currentSegs = this.videoSegmentationService.segments().map((s) => ({ ...s }));
        const currentOrder = [...this.getCorrelationOrder()];

        const prevSeg = initSegs.find((s) => s.id === segId);
        const currSeg = currentSegs.find((s) => s.id === segId);
        if (
          prevSeg &&
          currSeg &&
          (prevSeg.startTime !== currSeg.startTime || prevSeg.endTime !== currSeg.endTime)
        ) {
          this.undoRedoService.execute(
            new UpdateSegmentBoundaryCommand(
              initSegs,
              initOrder,
              currentSegs,
              currentOrder,
              segId,
              dragEdge,
              this.videoSegmentationService
            )
          );
        }

        if (dragEdge === 'start') {
          this.videoSegmentationService.requestSegmentThumbnail(segId);
        }
      }
      this.activeTabDrag = null;
      this.cleanupMouseListeners();
      this.endGhostPreview();
      this.justFinishedTabInteraction = true;
      setTimeout(() => {
        this.justFinishedTabInteraction = false;
      }, Timeline.JUST_FINISHED_ACTION_TIME_MS);
    });
  }

  /**
   * Handles keyboard events when focusing on a segment tab.
   */
  public onTabKeydown(event: KeyboardEvent, segment: VideoSegment, edge: 'start' | 'end'): void {
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      this.endGhostPreview();
      this.togglePlay();
      return;
    }

    const fps = this.videoSegmentationService.getFileFps(segment.fileId);
    const frameDuration = 1 / fps;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const initialTime = edge === 'start' ? segment.startTime : segment.endTime;
      this.startGhostPreview(segment.fileId, initialTime);
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();

      const beforeSegs = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const beforeOrder = [...this.getCorrelationOrder()];

      if (event.shiftKey) {
        // Snap to adjacent left boundary or playhead if intermediate
        const playheadTime = this.ghostPlayheadTime() ?? this.currentTime();
        const playheadFileId = this.ghostPlayheadFileId() ?? this.activeMediaFileId();
        const hasPlayheadInFile = playheadFileId === segment.fileId;

        if (edge === 'start') {
          const fileSegments = this.videoSegmentationService.segments()
            .filter((s) => s.fileId === segment.fileId && s.id !== segment.id)
            .sort((a, b) => a.startTime - b.startTime);
          const prev = fileSegments.filter((s) => s.endTime <= segment.startTime).pop();
          const targetLeft = prev ? prev.endTime : 0;
          if (hasPlayheadInFile && playheadTime < segment.startTime && playheadTime >= targetLeft) {
            this.videoSegmentationService.updateSegmentStart(segment.id!, playheadTime);
          } else {
            this.videoSegmentationService.updateSegmentStart(segment.id!, targetLeft);
          }
        } else {
          const minAllowedEnd = segment.startTime + frameDuration;
          if (hasPlayheadInFile && playheadTime < segment.endTime && playheadTime >= minAllowedEnd) {
            this.videoSegmentationService.updateSegmentEnd(segment.id!, playheadTime);
          } else {
            this.videoSegmentationService.updateSegmentEnd(segment.id!, minAllowedEnd);
          }
        }
      } else {
        const delta = event.ctrlKey ? -1 : -frameDuration;
        if (edge === 'start') {
          this.videoSegmentationService.updateSegmentStart(segment.id!, segment.startTime + delta);
        } else {
          this.videoSegmentationService.updateSegmentEnd(segment.id!, segment.endTime + delta);
        }
      }

      const updatedSeg = this.videoSegmentationService.segments()
        .find((s) => s.id === segment.id);
      if (updatedSeg) {
        this.currentTime.set(edge === 'start' ? updatedSeg.startTime : updatedSeg.endTime);
      }

      const afterSegs = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const afterOrder = [...this.getCorrelationOrder()];
      this.undoRedoService.execute(
        new UpdateSegmentBoundaryCommand(
          beforeSegs,
          beforeOrder,
          afterSegs,
          afterOrder,
          segment.id!,
          edge,
          this.videoSegmentationService
        )
      );

      this.scheduleGhostEndAfterTabKey(segment, edge);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();

      const beforeSegs = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const beforeOrder = [...this.getCorrelationOrder()];

      if (event.shiftKey) {
        // Snap to adjacent right boundary or playhead if intermediate
        const playheadTime = this.ghostPlayheadTime() ?? this.currentTime();
        const playheadFileId = this.ghostPlayheadFileId() ?? this.activeMediaFileId();
        const hasPlayheadInFile = playheadFileId === segment.fileId;

        if (edge === 'start') {
          const maxAllowedStart = segment.endTime - frameDuration;
          if (hasPlayheadInFile && playheadTime > segment.startTime && playheadTime <= maxAllowedStart) {
            this.videoSegmentationService.updateSegmentStart(segment.id!, playheadTime);
          } else {
            this.videoSegmentationService.updateSegmentStart(segment.id!, maxAllowedStart);
          }
        } else {
          const duration = this.videoSegmentationService.getFileDuration(segment.fileId) ?? segment.endTime;
          const fileSegments = this.videoSegmentationService.segments()
            .filter((s) => s.fileId === segment.fileId && s.id !== segment.id)
            .sort((a, b) => a.startTime - b.startTime);
          const next = fileSegments.find((s) => s.startTime >= segment.endTime);
          const targetRight = next ? next.startTime : duration;
          if (hasPlayheadInFile && playheadTime > segment.endTime && playheadTime <= targetRight) {
            this.videoSegmentationService.updateSegmentEnd(segment.id!, playheadTime);
          } else {
            this.videoSegmentationService.updateSegmentEnd(segment.id!, targetRight);
          }
        }
      } else {
        const delta = event.ctrlKey ? 1 : frameDuration;
        if (edge === 'start') {
          this.videoSegmentationService.updateSegmentStart(segment.id!, segment.startTime + delta);
        } else {
          this.videoSegmentationService.updateSegmentEnd(segment.id!, segment.endTime + delta);
        }
      }

      const updatedSeg = this.videoSegmentationService.segments()
        .find((s) => s.id === segment.id);
      if (updatedSeg) {
        this.currentTime.set(edge === 'start' ? updatedSeg.startTime : updatedSeg.endTime);
      }

      const afterSegs = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const afterOrder = [...this.getCorrelationOrder()];
      this.undoRedoService.execute(
        new UpdateSegmentBoundaryCommand(
          beforeSegs,
          beforeOrder,
          afterSegs,
          afterOrder,
          segment.id!,
          edge,
          this.videoSegmentationService
        )
      );

      this.scheduleGhostEndAfterTabKey(segment, edge);
    } else if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      event.stopPropagation();
      this.endGhostPreview();
      this.joinAtPlayhead();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      event.stopPropagation();
      this.endGhostPreview();
      const beforeSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const beforeOrder = [...this.getCorrelationOrder()];

      this.videoSegmentationService.deleteSegment(segment.id!);

      const afterSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const afterOrder = [...this.getCorrelationOrder()];
      this.undoRedoService.execute(
        new DeleteSegmentCommand(
          beforeSegments,
          beforeOrder,
          afterSegments,
          afterOrder,
          this.videoSegmentationService
        )
      );
    }
  }

  /**
   * Handles keyboard navigation on the main timeline track.
   */
  public onTrackKeydown(event: KeyboardEvent): void {
    const activeFile = this.activeMediaFile();
    if (!activeFile) {
      return;
    }

    const fps = this.videoSegmentationService.getFileFps(activeFile.id);
    const frameDuration = 1 / fps;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.isScrubbing.set(true);
      this.resetTrackKeyScrubTimer();
      if (event.shiftKey) {
        this.snapPlayheadToAdjacentSegment('backward');
      } else if (event.ctrlKey) {
        this.seekPlayhead(-1);
      } else {
        this.seekPlayhead(-frameDuration);
      }
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.isScrubbing.set(true);
      this.resetTrackKeyScrubTimer();
      if (event.shiftKey) {
        this.snapPlayheadToAdjacentSegment('forward');
      } else if (event.ctrlKey) {
        this.seekPlayhead(1);
      } else {
        this.seekPlayhead(frameDuration);
      }
    } else if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      this.togglePlay();
    } else if (event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      this.splitAtPlayhead();
    } else if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      this.joinAtPlayhead();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      this.deleteActiveOrFocusedSegment();
    } else if (event.ctrlKey && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      this.zoom(Timeline.CTRL_PLUS_MINUS_ZOOM_FACTOR);
    } else if (event.ctrlKey && (event.key === '-' || event.key === '_')) {
      event.preventDefault();
      this.zoom(1 / Timeline.CTRL_PLUS_MINUS_ZOOM_FACTOR);
    }
  }

  /**
   * Resets the debounce timer for keyboard-driven track scrubbing.
   */
  private resetTrackKeyScrubTimer(): void {
    if (this.trackKeyScrubTimer) {
      clearTimeout(this.trackKeyScrubTimer);
    }
    this.trackKeyScrubTimer = setTimeout(() => {
      this.trackKeyScrubTimer = null;
      this.isScrubbing.set(false);
    }, Timeline.TRACK_KEY_SCRUB_TIME_MS);
  }

  /**
   * Handles blur events on the track container to ensure keyboard scrubbing state is cleared.
   */
  public onTrackBlur(): void {
    if (this.trackKeyScrubTimer) {
      clearTimeout(this.trackKeyScrubTimer);
      this.trackKeyScrubTimer = null;
    }
    this.isScrubbing.set(false);
  }

  /**
   * Handles wheel events for Ctrl+Scroll zooming.
   */
  public onTrackWheel(event: WheelEvent): void {
    if (event.ctrlKey) {
      event.preventDefault();
      const factor = event.deltaY < 0 ? Timeline.CTRL_SCROLL_ZOOM_FACTOR : 1 / Timeline.CTRL_SCROLL_ZOOM_FACTOR;
      this.zoom(factor);
    }
  }

  /**
   * Auto-pans the timeline track during playback or tab focus.
   */
  public autoPanToPlayhead(): void {
    const container = this.trackContainer()?.nativeElement;
    if (!container) {
      return;
    }

    const playheadX = this.playheadPixelLeft();
    const scrollLeft = container.scrollLeft;
    const clientWidth = container.clientWidth;

    if (playheadX > scrollLeft + clientWidth - Timeline.AUTOPAN_MARGIN_PX) {
      container.scrollLeft = playheadX - Timeline.AUTOPAN_MARGIN_PX;
      this.trackScrollLeft.set(container.scrollLeft);
    } else if (playheadX < scrollLeft) {
      container.scrollLeft = Math.max(0, playheadX - Timeline.AUTOPAN_MARGIN_PX);
      this.trackScrollLeft.set(container.scrollLeft);
    }
  }

  /**
   * Centers the focused element in the timeline view.
   */
  public onTabFocus(event: FocusEvent): void {
    const element = event.target as HTMLElement | null;
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  /**
   * Adjusts the zoom level by a multiplier.
   */
  public zoom(multiplier: number): void {
    const current = this.pixelsPerSecond();
    const updated = Math.max(
      Timeline.MIN_PIXELS_PER_SECOND,
      Math.min(Timeline.MAX_PIXELS_PER_SECOND, current * multiplier)
    );
    this.pixelsPerSecond.set(updated);
  }

  /**
   * Increases timeline zoom by the standard zoom factor.
   */
  public zoomIn(): void {
    this.zoom(Timeline.CTRL_PLUS_MINUS_ZOOM_FACTOR);
  }

  /**
   * Decreases timeline zoom by the standard zoom factor.
   */
  public zoomOut(): void {
    this.zoom(1 / Timeline.CTRL_PLUS_MINUS_ZOOM_FACTOR);
  }

  /**
   * Toggles video playback.
   */
  public togglePlay(): void {
    if (this.isGhostPreview()) {
      this.endGhostPreview();
    }
    this.isPlaying.update((p) => !p);
    this.updateFocusForPlayhead(true);
  }

  /**
   * Seeks the playhead by delta seconds clamped to active video boundaries.
   */
  public seekPlayhead(delta: number): void {
    const active = this.activeMediaFile();
    if (!active) {
      return;
    }
    const duration = this.videoSegmentationService.getFileDuration(active.id) ?? Timeline.DEFAULT_FALLBACK_DURATION;
    const newTime = Math.max(0, Math.min(duration, this.currentTime() + delta));
    this.currentTime.set(newTime);
    this.updateFocusForPlayhead(true);
  }

  /**
   * Seeks the playhead forward or backward by one video frame.
   *
   * @param direction -1 for backward, 1 for forward.
   */
  public seekFrame(direction: 1 | -1): void {
    const active = this.activeMediaFile();
    const fps = active
      ? this.videoSegmentationService.getFileFps(active.id)
      : Timeline.DEFAULT_FPS;
    this.seekPlayhead(direction / fps);
  }

  /**
   * Formats an accessible description for an unsegmented gap interval.
   *
   * @param start The start timestamp of the gap in seconds.
   * @param end The end timestamp of the gap in seconds.
   * @returns Formatted localized string for screen readers.
   */
  public formatGapAriaLabel(start: number, end: number): string {
    const startStr = this.videoSegmentationService.formatTimestamp(start);
    const endStr = this.videoSegmentationService.formatTimestamp(end);
    return `Intervalo não segmentado de ${startStr} até ${endStr}`;
  }

  /**
   * Snaps the playhead to the next or previous segment boundary.
   */
  public snapPlayheadToAdjacentSegment(direction: 'forward' | 'backward'): void {
    const active = this.activeMediaFile();
    if (!active) {
      return;
    }

    const duration = this.videoSegmentationService.getFileDuration(active.id) ?? Timeline.DEFAULT_FALLBACK_DURATION;
    const segments = this.videoSegmentationService.segments()
      .filter((s) => s.fileId === active.id)
      .sort((a, b) => a.startTime - b.startTime);

    const boundaries = new Set<number>([0, duration]);
    for (const seg of segments) {
      boundaries.add(seg.startTime);
      boundaries.add(seg.endTime);
    }

    const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
    const curr = this.currentTime();

    if (direction === 'forward') {
      const next = sortedBoundaries.find((b) => b > curr + Timeline.BOUNDARY_SNAP_THRESHOLD);
      if (next !== undefined) {
        this.currentTime.set(next);
        this.updateFocusForPlayhead(true);
      }
    } else {
      const prev = sortedBoundaries.filter((b) => b < curr - Timeline.BOUNDARY_SNAP_THRESHOLD).pop();
      if (prev !== undefined) {
        this.currentTime.set(prev);
        this.updateFocusForPlayhead(true);
      }
    }
  }

  /**
   * Splits a segment at the playhead position (or creates a 1 s segment in unsegmented gaps).
   */
  public splitAtPlayhead(): void {
    const active = this.activeMediaFile();
    if (!active) {
      return;
    }

    const beforeSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
    const beforeOrder = [...this.getCorrelationOrder()];

    const created = this.videoSegmentationService.splitSegment(active.id, this.currentTime());
    if (created) {
      const afterSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const afterOrder = [...this.getCorrelationOrder()];
      this.undoRedoService.execute(
        new SplitSegmentCommand(
          beforeSegments,
          beforeOrder,
          afterSegments,
          afterOrder,
          this.videoSegmentationService
        )
      );
    }
    this.updateFocusForPlayhead(true);
  }

  /**
   * Joins two segments together at the playhead position if conditions allow.
   */
  public joinAtPlayhead(): void {
    const active = this.activeMediaFile();
    if (!active) {
      return;
    }

    const beforeSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
    const beforeOrder = [...this.getCorrelationOrder()];

    const joined = this.videoSegmentationService.joinSegments(active.id, this.currentTime());
    if (joined) {
      const afterSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const afterOrder = [...this.getCorrelationOrder()];
      this.undoRedoService.execute(
        new JoinSegmentsCommand(
          beforeSegments,
          beforeOrder,
          afterSegments,
          afterOrder,
          this.videoSegmentationService
        )
      );
    }
    this.updateFocusForPlayhead(true);
  }

  /**
   * Deletes the currently active segment at the playhead.
   */
  public deleteActiveOrFocusedSegment(): void {
    const active = this.activeMediaFile();
    if (!active) {
      return;
    }

    const seg = this.activeSegment();
    if (seg?.id) {
      const beforeSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const beforeOrder = [...this.getCorrelationOrder()];

      this.videoSegmentationService.deleteSegment(seg.id);

      const afterSegments = this.videoSegmentationService.segments().map((s) => ({ ...s }));
      const afterOrder = [...this.getCorrelationOrder()];
      this.undoRedoService.execute(
        new DeleteSegmentCommand(
          beforeSegments,
          beforeOrder,
          afterSegments,
          afterOrder,
          this.videoSegmentationService
        )
      );
      this.updateFocusForPlayhead(true);
    }
  }

  /**
   * Handles keydown on the timeline toolbar to prevent Space triggering toolbar buttons.
   */
  public onToolbarKeydown(event: KeyboardEvent): void {
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      this.togglePlay();
    }
  }

  /**
   * Checks whether pose landmarks are cached in memory for the currently active media file.
   *
   * @returns True if landmarks are cached for the active video.
   */
  public hasCachedLandmarks(): boolean {
    const activeId = this.activeMediaFileId();
    return activeId !== null && this.autoSegmentationService.hasCachedLandmarks(activeId);
  }

  /**
   * Toggles the visibility of the auto-segmentation panel.
   */
  public onMagicButtonClick(): void {
    this.isMagicPanelOpen.update((open) => !open);
  }

  /**
   * Handles immediate lambda slider adjustment by updating the service signal instantly and scheduling
   * an animation frame throttled recalculation of timeline segment boundaries.
   *
   * @param event The input change event from the range slider.
   */
  public onLambdaSliderChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    if (isNaN(value)) {
      return;
    }

    this.autoSegmentationService.setLambda(value);

    const activeId = this.activeMediaFileId();
    if (activeId && this.autoSegmentationService.hasCachedLandmarks(activeId)) {
      this.schedulePendingLambdaRecalculation(activeId, value);
    }
  }

  /**
   * Handles the commit event (slider release) by immediately flushing any pending lambda recalculation.
   */
  public onLambdaSliderCommit(): void {
    this.flushPendingLambdaRecalculation();
  }

  /**
   * Handles explicit numeric input of the lambda threshold, immediately cancelling pending throttled recalculations
   * and applying the exact value synchronously.
   *
   * @param event The change event from the numeric lambda input.
   */
  public onLambdaInputChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    if (isNaN(value)) {
      return;
    }

    this.cancelPendingLambdaRecalculation();
    this.autoSegmentationService.setLambda(value);

    const activeId = this.activeMediaFileId();
    if (activeId && this.autoSegmentationService.hasCachedLandmarks(activeId)) {
      this.autoSegmentationService.recalculateWithLambda(activeId, value);
    }
  }

  /**
   * Schedules a throttled lambda recalculation synchronized with the next animation frame.
   * Coalesces rapid intermediate values to prevent UI stutter during continuous slider adjustments.
   *
   * @param mediaFileId Target media file ID.
   * @param value Lambda threshold value to apply.
   */
  private schedulePendingLambdaRecalculation(mediaFileId: MediaFileId, value: number): void {
    this.pendingLambdaFileId = mediaFileId;
    this.pendingLambdaValue = value;

    if (this.lambdaRafId !== null || this.isRecalculatingLambda) {
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      this.lambdaRafId = requestAnimationFrame(() => {
        this.lambdaRafId = null;
        this.processPendingLambdaRecalculation();
      });
    } else {
      this.processPendingLambdaRecalculation();
    }
  }

  /**
   * Processes and drains pending lambda recalculations, skipping intermediate frames when rapid slider
   * movements occur.
   */
  private processPendingLambdaRecalculation(): void {
    if (this.pendingLambdaValue === null || this.pendingLambdaFileId === null) {
      return;
    }

    this.isRecalculatingLambda = true;
    try {
      while (this.pendingLambdaValue !== null && this.pendingLambdaFileId !== null) {
        const targetValue = this.pendingLambdaValue;
        const targetFileId = this.pendingLambdaFileId;
        this.pendingLambdaValue = null;
        this.pendingLambdaFileId = null;

        this.autoSegmentationService.recalculateWithLambda(targetFileId, targetValue);
      }
    } finally {
      this.isRecalculatingLambda = false;
      if (this.pendingLambdaValue !== null && this.pendingLambdaFileId !== null) {
        this.schedulePendingLambdaRecalculation(this.pendingLambdaFileId, this.pendingLambdaValue);
      }
    }
  }

  /**
   * Flushes any pending throttled lambda recalculation immediately.
   */
  private flushPendingLambdaRecalculation(): void {
    if (this.lambdaRafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.lambdaRafId);
      }
      this.lambdaRafId = null;
    }
    this.processPendingLambdaRecalculation();
  }

  /**
   * Cancels any pending scheduled lambda recalculation.
   */
  private cancelPendingLambdaRecalculation(): void {
    if (this.lambdaRafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.lambdaRafId);
      }
      this.lambdaRafId = null;
    }
    this.pendingLambdaValue = null;
    this.pendingLambdaFileId = null;
  }

  /**
   * Triggers automatic segmentation for the currently active media file using cached landmarks if available.
   */
  public async onRunMagicSegmentation(): Promise<void> {
    const activeId = this.activeMediaFileId();
    if (!activeId) {
      return;
    }
    await this.autoSegmentationService.runAutoSegmentation(activeId);
  }

  /**
   * Forces re-extraction of pose landmarks and recalculation of segments for the active media file.
   */
  public async onReextractLandmarks(): Promise<void> {
    const activeId = this.activeMediaFileId();
    if (!activeId) {
      return;
    }
    await this.autoSegmentationService.runAutoSegmentation(activeId, { forceReextract: true });
  }

  /**
   * Cancels active auto-segmentation processing.
   */
  public onCancelMagicSegmentation(): void {
    this.autoSegmentationService.cancel();
  }

  private scheduleGhostEndAfterTabKey(segment: VideoSegment, edge: 'start' | 'end'): void {
    if (this.tabKeyGhostTimer) {
      clearTimeout(this.tabKeyGhostTimer);
    }
    this.tabKeyGhostTimer = setTimeout(() => {
      this.tabKeyGhostTimer = null;
      if (edge === 'start' && segment.id) {
        this.videoSegmentationService.requestSegmentThumbnail(segment.id);
      }
      this.endGhostPreview();
    }, Timeline.TAB_KEY_GHOST_TIME_MS);
  }

  private cleanupMouseListeners(): void {
    if (this.unlistenMouseMove) {
      this.unlistenMouseMove();
      this.unlistenMouseMove = null;
    }
    if (this.unlistenMouseUp) {
      this.unlistenMouseUp();
      this.unlistenMouseUp = null;
    }
  }

  /**
   * Helper to safely retrieve current correlation order from VideoSegmentationService.
   *
   * @returns The current correlation order array.
   */
  private getCorrelationOrder(): readonly string[] {
    return this.videoSegmentationService.correlationOrder ? this.videoSegmentationService.correlationOrder() : [];
  }
}

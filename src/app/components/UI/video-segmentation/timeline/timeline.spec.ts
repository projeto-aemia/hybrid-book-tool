import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Timeline } from './timeline';
import { MediaFiles, type MediaFile, type MediaFileId } from '../../../../services/media-files/media-files';
import {
  VideoSegmentationService,
  type VideoSegment
} from '../../../../services/video-segmentation/video-segmentation';
import { Thumbnail } from '../../../../services/thumbnail/thumbnail';
import { AutoSegmentationService } from '../../../../services/auto-segmentation/auto-segmentation';
import { signal } from '@angular/core';
import { of } from 'rxjs';

interface TimelineConstants {
  MIN_PIXELS_PER_SECOND: number,
  MAX_PIXELS_PER_SECOND: number,
  FILMSTRIP_GAP: number,
}

describe('Timeline', () => {
  let component: Timeline;
  let fixture: ComponentFixture<Timeline>;
  let mockMediaFiles: { mediaFiles: ReturnType<typeof signal<MediaFile[]>> };
  let mockAutoSegmentation: {
    lambda: ReturnType<typeof signal<number>>,
    estimatedLambda: ReturnType<typeof signal<number | null>>,
    isProcessing: ReturnType<typeof signal<boolean>>,
    statusMessage: ReturnType<typeof signal<string>>,
    progressPercentage: ReturnType<typeof signal<number>>,
    hasCachedLandmarks: ReturnType<typeof vi.fn>,
    runAutoSegmentation: ReturnType<typeof vi.fn>,
    recalculateWithLambda: ReturnType<typeof vi.fn>,
    setLambda: ReturnType<typeof vi.fn>,
    resetLambdaToEstimated: ReturnType<typeof vi.fn>,
    syncActiveMediaFile: ReturnType<typeof vi.fn>,
    cancel: ReturnType<typeof vi.fn>,
  };
  let mockVideoSegmentation: {
    segments: ReturnType<typeof signal<VideoSegment[]>>,
    getFileDuration: ReturnType<typeof vi.fn>,
    getFileFps: ReturnType<typeof vi.fn>,
    formatTimestamp: ReturnType<typeof vi.fn>,
    splitSegment: ReturnType<typeof vi.fn>,
    deleteSegment: ReturnType<typeof vi.fn>,
    joinSegments: ReturnType<typeof vi.fn>,
    canJoinSegments: ReturnType<typeof vi.fn>,
    canSplitSegment: ReturnType<typeof vi.fn>,
    canCreateSegmentInGap: ReturnType<typeof vi.fn>,
    updateSegmentStart: ReturnType<typeof vi.fn>,
    updateSegmentEnd: ReturnType<typeof vi.fn>,
    requestSegmentThumbnail: ReturnType<typeof vi.fn>,
    findSegmentAtTime: ReturnType<typeof vi.fn>,
    correlationOrder: ReturnType<typeof signal<readonly string[]>>,
  };
  let mockThumbnail: {
    generateFilmstripThumbnails: ReturnType<typeof vi.fn>,
    freeAllFilmstripThumbnails: ReturnType<typeof vi.fn>,
  };

  const sampleFile1: MediaFile = {
    id: 'file-1' as MediaFileId,
    file: new File([], 'video1.mp4'),
    name: 'video1.mp4',
    url: 'blob:video1',
    thumbnail: null,
  };
  const sampleFile2: MediaFile = {
    id: 'file-2' as MediaFileId,
    file: new File([], 'video2.mp4'),
    name: 'video2.mp4',
    url: 'blob:video2',
    thumbnail: null,
  };

  beforeEach(async () => {
    mockMediaFiles = {
      mediaFiles: signal<MediaFile[]>([sampleFile1, sampleFile2]),
    };

    mockVideoSegmentation = {
      segments: signal<VideoSegment[]>([
        {
          id: 'seg-1',
          fileId: 'file-1' as MediaFileId,
          name: 'Seg 1',
          startTime: 10,
          endTime: 30,
          thumbnail: null,
        },
      ]),
      correlationOrder: signal<readonly string[]>(['seg-1']),
      getFileDuration: vi.fn((fileId: string) => (fileId === 'file-1' ? 60 : 80)),
      getFileFps: vi.fn(() => 30),
      formatTimestamp: vi.fn((sec: number) => `${Math.floor(sec)}s`),
      splitSegment: vi.fn(() => ({ id: 'new-seg' })),
      deleteSegment: vi.fn(),
      joinSegments: vi.fn(),
      canJoinSegments: vi.fn(() => false),
      canSplitSegment: vi.fn(() => true),
      canCreateSegmentInGap: vi.fn(() => false),
      updateSegmentStart: vi.fn(),
      updateSegmentEnd: vi.fn(),
      requestSegmentThumbnail: vi.fn(),
      findSegmentAtTime: vi.fn((fileId: MediaFileId, time: number) => {
        const segs = mockVideoSegmentation.segments()
          .filter((s) => s.fileId === fileId)
          .sort((a, b) => a.startTime - b.startTime);
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          const isLast = i === segs.length - 1;
          if (time >= seg.startTime && (time < seg.endTime || (isLast && time <= seg.endTime))) {
            return seg;
          }
        }
        return null;
      }),
    };

    mockThumbnail = {
      generateFilmstripThumbnails: vi.fn(() => of({
        mediaFileId: 'file-1',
        timestamp: 0,
        thumbnailUrl: 'blob:thumb0',
      })),
      freeAllFilmstripThumbnails: vi.fn(),
    };

    mockAutoSegmentation = {
      lambda: signal<number>(1.0),
      estimatedLambda: signal<number | null>(null),
      isProcessing: signal<boolean>(false),
      statusMessage: signal<string>(''),
      progressPercentage: signal<number>(0),
      hasCachedLandmarks: vi.fn(() => false),
      runAutoSegmentation: vi.fn().mockResolvedValue(undefined),
      recalculateWithLambda: vi.fn(),
      setLambda: vi.fn(),
      resetLambdaToEstimated: vi.fn(),
      syncActiveMediaFile: vi.fn(),
      cancel: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Timeline],
      providers: [
        { provide: MediaFiles, useValue: mockMediaFiles },
        { provide: VideoSegmentationService, useValue: mockVideoSegmentation },
        { provide: Thumbnail, useValue: mockThumbnail },
        { provide: AutoSegmentationService, useValue: mockAutoSegmentation },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Timeline);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('should create the timeline component', () => {
    expect(component).toBeTruthy();
  });

  describe('filmstrip layouts and gap calculation', () => {
    it('should compute layouts for each media file with separation gap', () => {
      component.pixelsPerSecond.set(50);
      const layouts = component['filmstripLayouts']();

      expect(layouts.length).toBe(2);
      expect(layouts[0].file.id).toBe('file-1');
      expect(layouts[0].left).toBe(16);
      expect(layouts[0].width).toBe(3000);

      expect(layouts[1].file.id).toBe('file-2');
      expect(layouts[1].left).toBe(16 + 3000 + (Timeline as unknown as TimelineConstants).FILMSTRIP_GAP);
      expect(layouts[1].width).toBe(4000);
    });

    it('should compute total track width encompassing all files plus padding', () => {
      const totalWidth = component['totalTrackWidth']();
      expect(totalWidth).toBeGreaterThan(7000);
    });

    it('should ensure total track width is at least the track viewport width when zoomed out', () => {
      component.trackViewportWidth.set(1200);
      component.pixelsPerSecond.set(0.1);

      const totalWidth = component['totalTrackWidth']();
      expect(totalWidth).toBe(1200);
    });

    it('should use track viewport width when there are no filmstrip layouts', () => {
      mockMediaFiles.mediaFiles.set([]);
      component.trackViewportWidth.set(1400);

      const totalWidth = component['totalTrackWidth']();
      expect(totalWidth).toBe(1400);
    });
  });

  describe('thumbnail slot generation', () => {
    it('should generate continuous thumbnail slots filling duration without gaps', () => {
      component.pixelsPerSecond.set(50);
      component.filmstripBodyHeight.set(80);

      const slots = component.getThumbnailSlots('file-1' as MediaFileId);
      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0].timestamp).toBe(0);
      expect(slots[0].left).toBe(0);
      expect(slots[0].key).toBeDefined();

      const aspect = 16 / 9;
      const expectedWidth = 80 * aspect;
      expect(slots[0].width).toBeCloseTo(expectedWidth, 1);

      // Subsequent slots are incremented by timeStep
      const timeStep = expectedWidth / 50;
      expect(slots[1].timestamp).toBeCloseTo(timeStep, 2);
      expect(slots[1].left).toBeCloseTo(expectedWidth, 1);
    });

    it('should evict failed thumbnail url on thumbnail error', () => {
      component['thumbnailsMap'].set(new Map([
        ['file-1', new Map([[0, 'blob:bad-thumb']])],
      ]));
      expect(component.getThumbnailUrl('file-1' as MediaFileId, 0)).toBe('blob:bad-thumb');

      component.onThumbnailError('file-1' as MediaFileId, 0);
      expect(component.getThumbnailUrl('file-1' as MediaFileId, 0)).toBeNull();
    });

    it('should free all filmstrip thumbnails on ngOnDestroy', () => {
      component.ngOnDestroy();
      expect(mockThumbnail.freeAllFilmstripThumbnails).toHaveBeenCalled();
    });
  });

  describe('unsegmented intervals computation', () => {
    it('should identify unsegmented regions for dimming/grayscale styling', () => {
      // file-1 duration is 60, seg-1 is [10, 30]
      const unsegmented = component.getUnsegmentedIntervals('file-1' as MediaFileId);

      expect(unsegmented.length).toBe(2);
      expect(unsegmented[0]).toEqual({ start: 0, end: 10 });
      expect(unsegmented[1]).toEqual({ start: 30, end: 60 });
    });

    it('should mark entire file as unsegmented when no segments exist', () => {
      // file-2 has no segments
      const unsegmented = component.getUnsegmentedIntervals('file-2' as MediaFileId);

      expect(unsegmented.length).toBe(1);
      expect(unsegmented[0]).toEqual({ start: 0, end: 80 });
    });
  });

  describe('playhead navigation and scrubbing', () => {
    it('should seek playhead by positive or negative delta clamped to duration', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      component.currentTime.set(20);

      component.seekPlayhead(5);
      expect(component.currentTime()).toBe(25);

      component.seekPlayhead(-10);
      expect(component.currentTime()).toBe(15);

      component.seekPlayhead(-50);
      expect(component.currentTime()).toBe(0);

      component.seekPlayhead(100);
      expect(component.currentTime()).toBe(60);
    });

    it('should snap playhead to next and previous segment boundaries', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      component.currentTime.set(0);

      // Next boundary should be seg-1 start (10)
      component.snapPlayheadToAdjacentSegment('forward');
      expect(component.currentTime()).toBe(10);

      // Next boundary should be seg-1 end (30)
      component.snapPlayheadToAdjacentSegment('forward');
      expect(component.currentTime()).toBe(30);

      // Previous boundary should be seg-1 start (10)
      component.snapPlayheadToAdjacentSegment('backward');
      expect(component.currentTime()).toBe(10);
    });

    it('should toggle play/pause state', () => {
      expect(component.isPlaying()).toBe(false);
      component.togglePlay();
      expect(component.isPlaying()).toBe(true);
      component.togglePlay();
      expect(component.isPlaying()).toBe(false);
    });
  });

  describe('zooming', () => {
    it('should zoom in and out within limits', () => {
      component.pixelsPerSecond.set(50);

      component.zoom(1.5);
      expect(component.pixelsPerSecond()).toBe(75);

      component.zoom(20);
      expect(component.pixelsPerSecond()).toBe((Timeline as unknown as TimelineConstants).MAX_PIXELS_PER_SECOND);

      component.zoom(0.00001);
      expect(component.pixelsPerSecond()).toBe((Timeline as unknown as TimelineConstants).MIN_PIXELS_PER_SECOND);
    });
  });

  describe('splitting and deleting', () => {
    it('should trigger splitSegment on K shortcut and update focus', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      component.currentTime.set(20);

      component.splitAtPlayhead();
      expect(mockVideoSegmentation.splitSegment).toHaveBeenCalledWith('file-1', 20);
    });

    it('should delete active segment on delete action', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      component.currentTime.set(15);
      mockVideoSegmentation.segments.set([{
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 20,
        thumbnail: null,
      }]);

      component.deleteActiveOrFocusedSegment();
      expect(mockVideoSegmentation.deleteSegment).toHaveBeenCalledWith('seg-1');
    });
  });

  describe('segment tab keyboard interaction', () => {
    const testSegment: VideoSegment = {
      id: 'seg-1',
      fileId: 'file-1' as MediaFileId,
      name: 'Seg 1',
      startTime: 10,
      endTime: 30,
      thumbnail: null,
    };

    it('should move start tab by 1 frame on ArrowLeft/Right', () => {
      const eventLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
      vi.spyOn(eventLeft, 'preventDefault');
      vi.spyOn(eventLeft, 'stopPropagation');

      component.onTabKeydown(eventLeft, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith(
        'seg-1',
        10 - (1 / 30)
      );

      const eventRight = new KeyboardEvent('keydown', { key: 'ArrowRight' });
      component.onTabKeydown(eventRight, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith(
        'seg-1',
        10 + (1 / 30)
      );
    });

    it('should move start tab by 1 second when holding Ctrl', () => {
      const eventCtrlLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true });
      component.onTabKeydown(eventCtrlLeft, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith('seg-1', 9);

      const eventCtrlRight = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true });
      component.onTabKeydown(eventCtrlRight, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith('seg-1', 11);
    });

    it('should snap tab to boundary when holding Shift', () => {
      const eventShiftLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true });
      component.onTabKeydown(eventShiftLeft, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith('seg-1', 0);

      const eventShiftRight = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true });
      component.onTabKeydown(eventShiftRight, testSegment, 'end');
      expect(mockVideoSegmentation.updateSegmentEnd).toHaveBeenCalledWith('seg-1', 60);
    });

    it('should snap tab to playhead when playhead is between tab and boundary on Shift+Arrow', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);

      // Case 1: Start tab, ArrowLeft, playhead at 5 (between 0 and 10)
      component.currentTime.set(5);
      const eventShiftLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true });
      component.onTabKeydown(eventShiftLeft, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith('seg-1', 5);

      // Second press when already at 5 (playhead) snaps to boundary (0)
      const segAt5: VideoSegment = { ...testSegment, startTime: 5 };
      component.onTabKeydown(eventShiftLeft, segAt5, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith('seg-1', 0);
      component.onTabBlur();

      // Case 2: Start tab, ArrowRight, playhead at 20 (between 10 and 30 - frameDuration)
      component.currentTime.set(20);
      const eventShiftRight = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true });
      component.onTabKeydown(eventShiftRight, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith('seg-1', 20);
      component.onTabBlur();

      // Case 3: End tab, ArrowLeft, playhead at 15 (between 10 + frameDuration and 30)
      component.currentTime.set(15);
      component.onTabKeydown(eventShiftLeft, testSegment, 'end');
      expect(mockVideoSegmentation.updateSegmentEnd).toHaveBeenCalledWith('seg-1', 15);
      component.onTabBlur();

      // Case 4: End tab, ArrowRight, playhead at 45 (between 30 and 60)
      component.currentTime.set(45);
      component.onTabKeydown(eventShiftRight, testSegment, 'end');
      expect(mockVideoSegmentation.updateSegmentEnd).toHaveBeenCalledWith('seg-1', 45);

      // Second press when already at 45 (playhead) snaps to boundary (60)
      const segAt45: VideoSegment = { ...testSegment, endTime: 45 };
      component.onTabKeydown(eventShiftRight, segAt45, 'end');
      expect(mockVideoSegmentation.updateSegmentEnd).toHaveBeenCalledWith('seg-1', 60);
      component.onTabBlur();
    });

    it('should not snap to playhead if playhead is on a different file', () => {
      component.activeMediaFileId.set('file-2' as MediaFileId);
      component.currentTime.set(5);
      const eventShiftLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true });
      component.onTabKeydown(eventShiftLeft, testSegment, 'start');
      expect(mockVideoSegmentation.updateSegmentStart).toHaveBeenCalledWith('seg-1', 0);
    });

    it('should delete segment on Delete key on tab', () => {
      const eventDel = new KeyboardEvent('keydown', { key: 'Delete' });
      component.onTabKeydown(eventDel, testSegment, 'start');
      expect(mockVideoSegmentation.deleteSegment).toHaveBeenCalledWith('seg-1');
    });
  });

  describe('track keyboard shortcuts', () => {
    it('should handle ArrowLeft and ArrowRight navigation', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      component.currentTime.set(20);

      const leftEvt = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
      component.onTrackKeydown(leftEvt);
      expect(component.currentTime()).toBeCloseTo(20 - (1 / 30), 2);

      const rightEvt = new KeyboardEvent('keydown', { key: 'ArrowRight' });
      component.onTrackKeydown(rightEvt);
      expect(component.currentTime()).toBeCloseTo(20, 2);
    });

    it('should handle space key to toggle play/pause', () => {
      const spaceEvt = new KeyboardEvent('keydown', { key: ' ' });
      component.onTrackKeydown(spaceEvt);
      expect(component.isPlaying()).toBe(true);
    });

    it('should handle k key to split segment', () => {
      const kEvt = new KeyboardEvent('keydown', { key: 'k' });
      component.onTrackKeydown(kEvt);
      expect(mockVideoSegmentation.splitSegment).toHaveBeenCalled();
    });

    it('should handle zoom shortcuts with Ctrl + / -', () => {
      component.pixelsPerSecond.set(50);

      const zoomInEvt = new KeyboardEvent('keydown', { key: '+', ctrlKey: true });
      component.onTrackKeydown(zoomInEvt);
      expect(component.pixelsPerSecond()).toBe(50 * 1.25);

      const zoomOutEvt = new KeyboardEvent('keydown', { key: '-', ctrlKey: true });
      component.onTrackKeydown(zoomOutEvt);
      expect(component.pixelsPerSecond()).toBeCloseTo(50, 1);
    });
  });

  describe('viewport-buffered thumbnail generation and scrolling', () => {
    it('should request thumbnails in two stages: visible window first, buffer second', () => {
      mockThumbnail.generateFilmstripThumbnails.mockClear();
      component.pixelsPerSecond.set(50);
      component.filmstripBodyHeight.set(80);
      component.trackViewportWidth.set(500);
      component.trackScrollLeft.set(0);

      component['requestFilmstripThumbnails']([sampleFile1, sampleFile2], 50, 80);

      // Stage 1 (visible) and Stage 2 (buffered on Stage 1 completion)
      expect(mockThumbnail.generateFilmstripThumbnails).toHaveBeenCalledTimes(2);

      // Stage 1: Only file-1 in visible viewport
      const stage1Arg = mockThumbnail.generateFilmstripThumbnails.mock.calls[0][0];
      expect(stage1Arg.files.length).toBe(1);
      expect(stage1Arg.files[0].mediaFileId).toBe('file-1');
      expect(stage1Arg.files[0].startTime).toBe(0);
      expect(stage1Arg.files[0].endTime).toBeLessThanOrEqual(12);

      // Stage 2: Buffered request includes wider range
      const stage2Arg = mockThumbnail.generateFilmstripThumbnails.mock.calls[1][0];
      expect(stage2Arg.files.length).toBeGreaterThanOrEqual(1);
    });

    it('should span multiple files when viewport and buffer overlap both files', () => {
      mockThumbnail.generateFilmstripThumbnails.mockClear();
      component.pixelsPerSecond.set(50);
      component.filmstripBodyHeight.set(80);
      component.trackViewportWidth.set(1000);
      component.trackScrollLeft.set(2500);

      component['requestFilmstripThumbnails']([sampleFile1, sampleFile2], 50, 80);

      expect(mockThumbnail.generateFilmstripThumbnails).toHaveBeenCalledTimes(2);
      const stage1Arg = mockThumbnail.generateFilmstripThumbnails.mock.calls[0][0];
      const stage2Arg = mockThumbnail.generateFilmstripThumbnails.mock.calls[1][0];

      // Stage 1: Visible window spans both file-1 and file-2
      expect(stage1Arg.files.length).toBe(2);
      expect(stage1Arg.files[0].mediaFileId).toBe('file-1');
      expect(stage1Arg.files[1].mediaFileId).toBe('file-2');
      expect(stage1Arg.files[0].startTime).toBeGreaterThan(0);
      expect(stage1Arg.files[0].endTime).toBe(60);
      expect(stage1Arg.files[1].startTime).toBe(0);

      // Stage 2: Buffered request also covers both files
      expect(stage2Arg.files.length).toBe(2);
      expect(stage2Arg.files[0].mediaFileId).toBe('file-1');
      expect(stage2Arg.files[1].mediaFileId).toBe('file-2');
      expect(stage2Arg.files[0].endTime).toBe(60);
      expect(stage2Arg.files[1].startTime).toBe(0);
      expect(stage2Arg.files[1].endTime).toBe(80);
    });

    it('should retain existing thumbnailsMap when re-requesting at same zoom level', () => {
      component['thumbnailsMap'].set(new Map([
        ['file-1', new Map([[10, 'blob:cached-10']])],
      ]));

      component.pixelsPerSecond.set(50);
      component.filmstripBodyHeight.set(80);
      component.trackViewportWidth.set(500);
      component.trackScrollLeft.set(0);

      // Set lastRequestedZoomInterval to match current zoom interval
      const aspect = 16 / 9;
      const thumbWidth = 80 * aspect;
      const expectedInterval = Math.max(0.1, thumbWidth / 50);
      component['lastRequestedZoomInterval'] = expectedInterval;

      component['requestFilmstripThumbnails']([sampleFile1, sampleFile2], 50, 80);

      // thumbnailsMap should NOT be wiped; cached timestamp 10 should still be present
      expect(component.getThumbnailUrl('file-1' as MediaFileId, 10)).toBe('blob:cached-10');
    });

    it('should debounce track scroll events when zoom is not settling', () => {
      vi.useFakeTimers();
      component['zoomDebounceTimer'] = null;
      const trackEl = document.createElement('div');
      Object.defineProperty(component, 'trackContainer', {
        value: () => ({ nativeElement: trackEl }),
      });

      component.onTrackScroll();
      expect(component['scrollDebounceTimer']).not.toBeNull();
      vi.useRealTimers();
    });

    it('should clear debounce timers on ngOnDestroy', () => {
      vi.useFakeTimers();
      component['zoomDebounceTimer'] = setTimeout(() => 1, 150);
      component['scrollDebounceTimer'] = setTimeout(() => 1, 100);

      expect(component['zoomDebounceTimer']).not.toBeNull();
      expect(component['scrollDebounceTimer']).not.toBeNull();

      component.ngOnDestroy();
      expect(component['zoomDebounceTimer']).toBeNull();
      expect(component['scrollDebounceTimer']).toBeNull();
      vi.useRealTimers();
    });

    it('should debounce zoom thumbnail requests by 150ms', () => {
      vi.useFakeTimers();
      mockThumbnail.generateFilmstripThumbnails.mockClear();

      component['scheduleZoomThumbnailRequest']([sampleFile1], 50, 80);
      expect(mockThumbnail.generateFilmstripThumbnails).not.toHaveBeenCalled();
      expect(component['zoomDebounceTimer']).not.toBeNull();

      vi.advanceTimersByTime(149);
      expect(mockThumbnail.generateFilmstripThumbnails).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(mockThumbnail.generateFilmstripThumbnails).toHaveBeenCalled();
      expect(component['zoomDebounceTimer']).toBeNull();
      vi.useRealTimers();
    });

    it('should toggle isPlaying when togglePlay is called', () => {
      expect(component.isPlaying()).toBe(false);
      component.togglePlay();
      expect(component.isPlaying()).toBe(true);
      component.togglePlay();
      expect(component.isPlaying()).toBe(false);
    });

    it('should toggle isPlaying when Space key is pressed on track', () => {
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      component.onTrackKeydown(event);
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(component.isPlaying()).toBe(true);
    });

    it('should set isScrubbing on track mousedown and clear it on window mouseup', () => {
      const event = new MouseEvent('mousedown', { clientX: 100 });
      component.onTrackMouseDown(event);

      expect(component.isScrubbing()).toBe(true);

      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(component.isScrubbing()).toBe(false);
    });

    it('should ignore track mousedown and click if event occurs on scrollbar', () => {
      const container = fixture.nativeElement.querySelector('.timeline-track-container');
      Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true });
      Object.defineProperty(container, 'clientWidth', { value: 500, configurable: true });
      Object.defineProperty(container, 'scrollHeight', { value: 100, configurable: true });
      Object.defineProperty(container, 'scrollWidth', { value: 1000, configurable: true });
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        top: 50,
        left: 50,
        bottom: 165,
        right: 550,
        width: 500,
        height: 115,
      } as DOMRect);

      const initialTime = 12;
      component.currentTime.set(initialTime);

      // Mouse down in the scrollbar region (clientY = 155 -> relativeY = 105 >= clientHeight 100)
      const scrollbarMouseDown = new MouseEvent('mousedown', { clientX: 200, clientY: 155 });
      component.onTrackMouseDown(scrollbarMouseDown);
      expect(component.isScrubbing()).toBe(false);
      expect(component.currentTime()).toBe(initialTime);

      // Click in the scrollbar region
      const scrollbarClick = new MouseEvent('click', { clientX: 200, clientY: 155 });
      component.onTrackClick(scrollbarClick);
      expect(component.currentTime()).toBe(initialTime);
    });

    it('should handle onSegmentMouseDown by delegating to track mouse down and updating focus', () => {
      const seg: VideoSegment = {
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 30,
        thumbnail: null,
      };
      const event = new MouseEvent('mousedown', { clientX: 50 });
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
      const onTrackMouseDownSpy = vi.spyOn(component, 'onTrackMouseDown');
      const updateFocusSpy = vi.spyOn(component, 'updateFocusForPlayhead');

      component.onSegmentMouseDown(event, seg);

      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(onTrackMouseDownSpy).toHaveBeenCalledWith(event, 'file-1');
      expect(updateFocusSpy).toHaveBeenCalledWith(true);
    });

    it('should prevent default and stop propagation when segment tab is clicked', () => {
      const event = new MouseEvent('mousedown', { clientX: 50 });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

      const seg: VideoSegment = {
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 30,
        thumbnail: null,
      };
      component.onTabMouseDown(event, seg, 'start');

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(component.isScrubbing()).toBe(true);

      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(component.isScrubbing()).toBe(false);
    });

    it('should initiate ghost preview and preserve playhead position during tab dragging', () => {
      component.currentTime.set(5);
      const initialPlayheadX = component['playheadPixelLeft']();

      const seg: VideoSegment = {
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 30,
        thumbnail: null,
      };

      const event = new MouseEvent('mousedown', { clientX: 100 });
      component.onTabMouseDown(event, seg, 'start');

      expect(component['isGhostPreview']()).toBe(true);
      expect(component.isScrubbing()).toBe(true);
      expect(component.currentTime()).toBe(10);
      expect(component['playheadPixelLeft']()).toBe(initialPlayheadX);

      // Simulate mousemove to drag tab
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 }));
      expect(component['isGhostPreview']()).toBe(true);
      expect(component['playheadPixelLeft']()).toBe(initialPlayheadX);

      // Finish drag
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(component['isGhostPreview']()).toBe(false);
      expect(component.isScrubbing()).toBe(false);
      expect(component.currentTime()).toBe(5);
      expect(component['playheadPixelLeft']()).toBe(initialPlayheadX);
    });

    it('should ignore track clicks immediately following tab dragging', () => {
      component.currentTime.set(5);
      const seg: VideoSegment = {
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 30,
        thumbnail: null,
      };

      const downEvent = new MouseEvent('mousedown', { clientX: 100 });
      component.onTabMouseDown(downEvent, seg, 'start');
      window.dispatchEvent(new MouseEvent('mouseup'));

      // Immediate track click event should be suppressed
      const clickEvent = new MouseEvent('click', { clientX: 300 });
      component.onTrackClick(clickEvent);
      expect(component.currentTime()).toBe(5);
    });

    it('should activate ghost preview on keyboard tab navigation and revert after debounce', () => {
      vi.useFakeTimers();
      component.currentTime.set(8);
      const initialPlayheadX = component['playheadPixelLeft']();

      const seg: VideoSegment = {
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 30,
        thumbnail: null,
      };

      const keyEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
      component.onTabKeydown(keyEvent, seg, 'start');

      expect(component['isGhostPreview']()).toBe(true);
      expect(component.isScrubbing()).toBe(true);
      expect(component['playheadPixelLeft']()).toBe(initialPlayheadX);

      vi.advanceTimersByTime(599);
      expect(component['isGhostPreview']()).toBe(true);

      vi.advanceTimersByTime(2);
      expect(component['isGhostPreview']()).toBe(false);
      expect(component.isScrubbing()).toBe(false);
      expect(component.currentTime()).toBe(8);
      expect(component['playheadPixelLeft']()).toBe(initialPlayheadX);
      vi.useRealTimers();
    });

    it('should revert keyboard ghost preview immediately on tab blur', () => {
      component.currentTime.set(8);
      const seg: VideoSegment = {
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 30,
        thumbnail: null,
      };

      const keyEvent = new KeyboardEvent('keydown', { key: 'ArrowRight' });
      component.onTabKeydown(keyEvent, seg, 'start');

      expect(component['isGhostPreview']()).toBe(true);
      component.onTabBlur();
      expect(component['isGhostPreview']()).toBe(false);
      expect(component.currentTime()).toBe(8);
    });

    it('should set isScrubbing on track ArrowLeft/ArrowRight and clear on timer or blur', () => {
      vi.useFakeTimers();
      component.activeMediaFileId.set('file-1' as MediaFileId);
      fixture.detectChanges();

      const leftEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
      component.onTrackKeydown(leftEvent);
      expect(component.isScrubbing()).toBe(true);

      vi.advanceTimersByTime(300);
      expect(component.isScrubbing()).toBe(false);

      const rightEvent = new KeyboardEvent('keydown', { key: 'ArrowRight' });
      component.onTrackKeydown(rightEvent);
      expect(component.isScrubbing()).toBe(true);

      component.onTrackBlur();
      expect(component.isScrubbing()).toBe(false);

      vi.useRealTimers();
    });

    it('should not request segment thumbnail immediately on onTabKeydown, but on debounce or blur', () => {
      vi.useFakeTimers();
      const seg: VideoSegment = {
        id: 'seg-1',
        fileId: 'file-1' as MediaFileId,
        name: 'Seg 1',
        startTime: 10,
        endTime: 30,
        thumbnail: null,
      };

      const keyEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
      component.onTabKeydown(keyEvent, seg, 'start');

      expect(mockVideoSegmentation.requestSegmentThumbnail).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600);
      expect(mockVideoSegmentation.requestSegmentThumbnail).toHaveBeenCalledWith('seg-1');

      mockVideoSegmentation.requestSegmentThumbnail.mockClear();
      component.onTabKeydown(keyEvent, seg, 'start');
      expect(mockVideoSegmentation.requestSegmentThumbnail).not.toHaveBeenCalled();

      component.onTabBlur(seg, 'start');
      expect(mockVideoSegmentation.requestSegmentThumbnail).toHaveBeenCalledWith('seg-1');

      vi.useRealTimers();
    });
  });

  describe('focus and keyboard navigation enhancements', () => {
    const testSegment: VideoSegment = {
      id: 'seg-1',
      fileId: 'file-1' as MediaFileId,
      name: 'Seg 1',
      startTime: 10,
      endTime: 30,
      thumbnail: null,
    };

    it('should prevent default and toggle play on space in toolbar keydown', () => {
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
      const togglePlaySpy = vi.spyOn(component, 'togglePlay');

      component.onToolbarKeydown(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(togglePlaySpy).toHaveBeenCalled();
    });

    it('should end ghost preview and toggle play when Space is pressed on a segment tab', () => {
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
      const togglePlaySpy = vi.spyOn(component, 'togglePlay');

      component.onTabKeydown(event, testSegment, 'start');

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(togglePlaySpy).toHaveBeenCalled();
    });

    it('should produce interleaved chronological track items with gaps and segments', () => {
      mockVideoSegmentation.getFileDuration.mockReturnValue(50);
      mockVideoSegmentation.segments.set([
        {
          id: 'seg-1',
          fileId: 'file-1' as MediaFileId,
          name: 'Seg 1',
          startTime: 10,
          endTime: 20,
          thumbnail: null,
        },
        {
          id: 'seg-2',
          fileId: 'file-1' as MediaFileId,
          name: 'Seg 2',
          startTime: 30,
          endTime: 40,
          thumbnail: null,
        },
      ]);

      const items = component.getTimelineTrackItems('file-1' as MediaFileId);
      expect(items.length).toBe(5);
      expect(items[0]).toEqual({ type: 'gap', index: 0, start: 0, end: 10, key: 'gap-file-1-0' });
      expect(items[1].type).toBe('segment');
      expect(items[2]).toEqual({ type: 'gap', index: 1, start: 20, end: 30, key: 'gap-file-1-1' });
      expect(items[3].type).toBe('segment');
      expect(items[4]).toEqual({ type: 'gap', index: 2, start: 40, end: 50, key: 'gap-file-1-2' });
    });

    it('should compute activeSegment based on currentTime and active file', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockVideoSegmentation.segments.set([
        {
          id: 'seg-1',
          fileId: 'file-1' as MediaFileId,
          name: 'Seg 1',
          startTime: 10,
          endTime: 20,
          thumbnail: null,
        },
      ]);

      // Within segment [10, 20]
      component.currentTime.set(15);
      expect(component.activeSegment()?.id).toBe('seg-1');

      // In gap before segment
      component.currentTime.set(5);
      expect(component.activeSegment()).toBeNull();

      // In gap after segment
      component.currentTime.set(25);
      expect(component.activeSegment()).toBeNull();
    });

    it('should seek playhead by one frame forward and backward using getFileFps', () => {
      mockVideoSegmentation.getFileFps.mockReturnValue(25);
      component.activeMediaFileId.set('file-1' as MediaFileId);
      component.currentTime.set(10);

      component.seekFrame(1);
      expect(component.currentTime()).toBeCloseTo(10 + 1 / 25);

      component.seekFrame(-1);
      expect(component.currentTime()).toBeCloseTo(10);
    });

    it('should zoom in and zoom out using standard zoom factor', () => {
      component.pixelsPerSecond.set(50);

      component.zoomIn();
      expect(component.pixelsPerSecond()).toBe(50 * 1.25);

      component.zoomOut();
      expect(component.pixelsPerSecond()).toBeCloseTo(50);
    });

    it('should cache getThumbnailSlots results across calls with identical parameters', () => {
      const slots1 = component.getThumbnailSlots('file-1' as MediaFileId);
      const slots2 = component.getThumbnailSlots('file-1' as MediaFileId);
      expect(slots1).toBe(slots2);

      component.pixelsPerSecond.set(100);
      const slots3 = component.getThumbnailSlots('file-1' as MediaFileId);
      expect(slots3).not.toBe(slots1);
    });

    it('should format gap aria label with timestamps', () => {
      mockVideoSegmentation.formatTimestamp.mockImplementation((s: number) => `${s}s`);
      const label = component.formatGapAriaLabel(5, 15);
      expect(label).toBe('Intervalo não segmentado de 5s até 15s');
    });

    describe('toolbar buttons and join functionality', () => {
      it('should compute canJoinAtPlayhead from videoSegmentationService.canJoinSegments', () => {
        mockVideoSegmentation.canJoinSegments.mockReturnValue(true);
        mockVideoSegmentation.segments.update((s) => [...s]);
        expect(component.canJoinAtPlayhead()).toBe(true);

        mockVideoSegmentation.canJoinSegments.mockReturnValue(false);
        mockVideoSegmentation.segments.update((s) => [...s]);
        expect(component.canJoinAtPlayhead()).toBe(false);
      });

      it('should compute cutButtonState as split, create, or disabled', () => {
        // When canSplitSegment is true
        mockVideoSegmentation.canSplitSegment.mockReturnValue(true);
        mockVideoSegmentation.canCreateSegmentInGap.mockReturnValue(false);
        mockVideoSegmentation.segments.update((s) => [...s]);
        expect(component.cutButtonState()).toBe('split');
        expect(component.cutButtonAriaLabel()).toContain('Dividir');
        expect(component.cutButtonTitle()).toBe('Dividir segmento (K)');

        // When canCreateSegmentInGap is true
        mockVideoSegmentation.canSplitSegment.mockReturnValue(false);
        mockVideoSegmentation.canCreateSegmentInGap.mockReturnValue(true);
        mockVideoSegmentation.segments.update((s) => [...s]);
        expect(component.cutButtonState()).toBe('create');
        expect(component.cutButtonAriaLabel()).toContain('Criar');
        expect(component.cutButtonTitle()).toBe('Criar segmento (K)');

        // When neither is true
        mockVideoSegmentation.canSplitSegment.mockReturnValue(false);
        mockVideoSegmentation.canCreateSegmentInGap.mockReturnValue(false);
        mockVideoSegmentation.segments.update((s) => [...s]);
        expect(component.cutButtonState()).toBe('disabled');
      });

      it('should compute canDeleteAtPlayhead true only when activeSegment exists', () => {
        component.currentTime.set(15);
        expect(component.canDeleteAtPlayhead()).toBe(true);

        component.currentTime.set(50);
        expect(component.canDeleteAtPlayhead()).toBe(false);
      });

      it('should call videoSegmentationService.joinSegments when joinAtPlayhead is invoked', () => {
        component.currentTime.set(20);
        component.joinAtPlayhead();

        expect(mockVideoSegmentation.joinSegments).toHaveBeenCalledWith('file-1', 20);
      });

      it('should trigger joinAtPlayhead when J or j is pressed on track', () => {
        const joinSpy = vi.spyOn(component, 'joinAtPlayhead');
        const eventJ = new KeyboardEvent('keydown', { key: 'j' });
        const preventDefaultSpy = vi.spyOn(eventJ, 'preventDefault');

        component.onTrackKeydown(eventJ);
        expect(preventDefaultSpy).toHaveBeenCalled();
        expect(joinSpy).toHaveBeenCalled();

        const eventCapitalJ = new KeyboardEvent('keydown', { key: 'J' });
        component.onTrackKeydown(eventCapitalJ);
        expect(joinSpy).toHaveBeenCalledTimes(2);
      });

      it('should trigger joinAtPlayhead when J or j is pressed on segment tab', () => {
        const joinSpy = vi.spyOn(component, 'joinAtPlayhead');
        const eventJ = new KeyboardEvent('keydown', { key: 'j' });
        const preventDefaultSpy = vi.spyOn(eventJ, 'preventDefault');
        const stopPropagationSpy = vi.spyOn(eventJ, 'stopPropagation');

        component.onTabKeydown(eventJ, testSegment, 'start');
        expect(preventDefaultSpy).toHaveBeenCalled();
        expect(stopPropagationSpy).toHaveBeenCalled();
        expect(joinSpy).toHaveBeenCalled();
      });

      it('should render Cut, Join, and Delete buttons in toolbar with appropriate disabled attributes', async () => {
        mockVideoSegmentation.canJoinSegments.mockReturnValue(false);
        mockVideoSegmentation.canSplitSegment.mockReturnValue(true);
        component.currentTime.set(15);
        fixture.detectChanges();
        await fixture.whenStable();

        const buttons = fixture.nativeElement.querySelectorAll('.timeline-header-toolbar .timeline-header-button');

        const magicButton = buttons[0] as HTMLButtonElement;
        const cutButton = buttons[1] as HTMLButtonElement;
        const joinButton = buttons[2] as HTMLButtonElement;
        const deleteButton = buttons[3] as HTMLButtonElement;

        expect(magicButton.disabled).toBe(false);
        expect(cutButton.disabled).toBe(false);
        expect(joinButton.disabled).toBe(true);
        expect(deleteButton.disabled).toBe(false);

        // When join is allowed and playhead is in gap
        mockVideoSegmentation.canJoinSegments.mockReturnValue(true);
        mockVideoSegmentation.canSplitSegment.mockReturnValue(false);
        mockVideoSegmentation.canCreateSegmentInGap.mockReturnValue(true);
        component.currentTime.set(50);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(cutButton.disabled).toBe(false);
        expect(joinButton.disabled).toBe(false);
        expect(deleteButton.disabled).toBe(true);
      });
    });

    describe('segment boundary keyboard focus', () => {
      it('should focus segment-start-anchor when playhead is at segment startTime', async () => {
        component.activeMediaFileId.set('file-1' as MediaFileId);
        mockVideoSegmentation.segments.set([
          {
            id: 'seg-1',
            fileId: 'file-1' as MediaFileId,
            name: 'Seg 1',
            startTime: 10,
            endTime: 20,
            thumbnail: null,
          },
          {
            id: 'seg-2',
            fileId: 'file-1' as MediaFileId,
            name: 'Seg 2',
            startTime: 20,
            endTime: 30,
            thumbnail: null,
          },
        ]);
        component.currentTime.set(20);
        fixture.detectChanges();
        await fixture.whenStable();

        component.updateFocusForPlayhead(true);
        expect(component['lastFocusedEntityId']).toBe('segment-start-anchor-seg-2');
        const anchor = fixture.nativeElement.querySelector('#segment-start-anchor-seg-2');
        expect(document.activeElement).toBe(anchor);
      });

      it('should focus segment-content when playhead is strictly inside the segment', async () => {
        component.activeMediaFileId.set('file-1' as MediaFileId);
        mockVideoSegmentation.segments.set([
          {
            id: 'seg-1',
            fileId: 'file-1' as MediaFileId,
            name: 'Seg 1',
            startTime: 10,
            endTime: 20,
            thumbnail: null,
          },
        ]);
        component.currentTime.set(15);
        fixture.detectChanges();
        await fixture.whenStable();

        component.updateFocusForPlayhead(true);
        expect(component['lastFocusedEntityId']).toBe('segment-content-seg-1');
        const content = fixture.nativeElement.querySelector('#segment-content-seg-1');
        expect(document.activeElement).toBe(content);
      });

      it('should have segment-start-anchor preceding start-tab in DOM order', async () => {
        component.activeMediaFileId.set('file-1' as MediaFileId);
        mockVideoSegmentation.segments.set([
          {
            id: 'seg-1',
            fileId: 'file-1' as MediaFileId,
            name: 'Seg 1',
            startTime: 10,
            endTime: 20,
            thumbnail: null,
          },
        ]);
        fixture.detectChanges();
        await fixture.whenStable();

        const anchor = fixture.nativeElement.querySelector('#segment-start-anchor-seg-1');
        const startTab = fixture.nativeElement.querySelector('.segment-tab.start-tab');
        expect(anchor).toBeTruthy();
        expect(startTab).toBeTruthy();
        expect(anchor.compareDocumentPosition(startTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });
    });
  });

  describe('magic auto-segmentation integration', () => {
    it('should toggle magic panel visibility when magic button is clicked', () => {
      expect(component.isMagicPanelOpen()).toBe(false);
      component.onMagicButtonClick();
      expect(component.isMagicPanelOpen()).toBe(true);
      component.onMagicButtonClick();
      expect(component.isMagicPanelOpen()).toBe(false);
    });

    it('should report whether landmarks are cached for the active file', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(true);
      expect(component.hasCachedLandmarks()).toBe(true);

      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(false);
      expect(component.hasCachedLandmarks()).toBe(false);
    });

    it('should invoke runAutoSegmentation when onRunMagicSegmentation is called', async () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      await component.onRunMagicSegmentation();
      expect(mockAutoSegmentation.runAutoSegmentation).toHaveBeenCalledWith('file-1');
    });

    it('should invoke runAutoSegmentation with forceReextract when onReextractLandmarks is called', async () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      await component.onReextractLandmarks();
      expect(mockAutoSegmentation.runAutoSegmentation).toHaveBeenCalledWith('file-1', {
        forceReextract: true,
      });
    });

    it('should invoke cancel on auto-segmentation service when cancelled', () => {
      component.onCancelMagicSegmentation();
      expect(mockAutoSegmentation.cancel).toHaveBeenCalled();
    });

    it('should reset lambda to estimated and recalculate when onResetLambdaToEstimated is called', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.estimatedLambda.set(0.85);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(true);

      component.onResetLambdaToEstimated();

      expect(mockAutoSegmentation.resetLambdaToEstimated).toHaveBeenCalled();
      expect(mockAutoSegmentation.recalculateWithLambda).toHaveBeenCalledWith('file-1', 0.85, { isManual: false });
    });

    it(
      'should render estimated badge and button in UI when estimated lambda is available ' +
      'and differs from lambda',
      async () => {
        component.isMagicPanelOpen.set(true);
        mockAutoSegmentation.lambda.set(1.2);
        mockAutoSegmentation.estimatedLambda.set(0.75);
        fixture.detectChanges();
        await fixture.whenStable();

        const compiled = fixture.nativeElement as HTMLElement;
        const badge = compiled.querySelector('.magic-estimated-badge');
        const resetBtn = compiled.querySelector('.magic-reset-lambda-btn') as HTMLButtonElement;

        expect(badge).toBeTruthy();
        expect(badge?.textContent).toContain('0.75');
        expect(resetBtn).toBeTruthy();

        resetBtn.click();
        expect(mockAutoSegmentation.resetLambdaToEstimated).toHaveBeenCalled();
      }
    );

    it('should update lambda signal immediately and schedule throttled recalculation via rAF on slider change', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(true);
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      rafSpy.mockClear();

      const mockEvent = { target: { value: '1.25' } } as unknown as Event;
      component.onLambdaSliderChange(mockEvent);

      expect(mockAutoSegmentation.setLambda).toHaveBeenCalledWith(1.25);
      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(mockAutoSegmentation.recalculateWithLambda).not.toHaveBeenCalled();

      rafSpy.mockRestore();
    });

    it('should coalesce rapid consecutive slider changes into a single rAF recalculation with the latest value', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(true);

      let rafCallback: FrameRequestCallback | null = null;
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
        rafCallback = cb;
        return 123;
      });

      component.onLambdaSliderChange({ target: { value: '0.8' } } as unknown as Event);
      component.onLambdaSliderChange({ target: { value: '1.2' } } as unknown as Event);
      component.onLambdaSliderChange({ target: { value: '1.5' } } as unknown as Event);

      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(mockAutoSegmentation.setLambda).toHaveBeenCalledWith(1.5);
      expect(mockAutoSegmentation.recalculateWithLambda).not.toHaveBeenCalled();

      expect(rafCallback).not.toBeNull();
      rafCallback!(performance.now());

      expect(mockAutoSegmentation.recalculateWithLambda).toHaveBeenCalledTimes(1);
      expect(mockAutoSegmentation.recalculateWithLambda).toHaveBeenCalledWith('file-1', 1.5);

      rafSpy.mockRestore();
    });

    it('should immediately flush pending recalculation on slider commit', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(true);

      const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame');
      component.onLambdaSliderChange({ target: { value: '1.4' } } as unknown as Event);

      expect(mockAutoSegmentation.recalculateWithLambda).not.toHaveBeenCalled();

      component.onLambdaSliderCommit();

      expect(cancelRafSpy).toHaveBeenCalled();
      expect(mockAutoSegmentation.recalculateWithLambda).toHaveBeenCalledWith('file-1', 1.4);

      cancelRafSpy.mockRestore();
    });

    it('should cancel pending rAF and immediately recalculate synchronously on numeric input change', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(true);

      const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame');
      component.onLambdaSliderChange({ target: { value: '0.9' } } as unknown as Event);

      component.onLambdaInputChange({ target: { value: '1.1' } } as unknown as Event);

      expect(cancelRafSpy).toHaveBeenCalled();
      expect(mockAutoSegmentation.setLambda).toHaveBeenCalledWith(1.1);
      expect(mockAutoSegmentation.recalculateWithLambda).toHaveBeenCalledWith('file-1', 1.1);

      cancelRafSpy.mockRestore();
    });

    it('should cancel pending rAF recalculation when component is destroyed', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(true);

      const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame');
      component.onLambdaSliderChange({ target: { value: '1.3' } } as unknown as Event);

      component.ngOnDestroy();

      expect(cancelRafSpy).toHaveBeenCalled();
      cancelRafSpy.mockRestore();
    });

    it('should update lambda without scheduling recalculation when landmarks are not cached', () => {
      component.activeMediaFileId.set('file-1' as MediaFileId);
      mockAutoSegmentation.hasCachedLandmarks.mockReturnValue(false);
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

      component.onLambdaSliderChange({ target: { value: '0.75' } } as unknown as Event);

      expect(mockAutoSegmentation.setLambda).toHaveBeenCalledWith(0.75);
      expect(rafSpy).not.toHaveBeenCalled();
      expect(mockAutoSegmentation.recalculateWithLambda).not.toHaveBeenCalled();

      rafSpy.mockRestore();
    });
  });
});

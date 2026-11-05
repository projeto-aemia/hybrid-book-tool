import { TestBed } from '@angular/core/testing';
import { AutoSegmentationService } from './auto-segmentation';
import { LandmarkExtractionService } from '../landmark-extraction/landmark-extraction';
import { VideoSegmentationService, type VideoSegment } from '../video-segmentation/video-segmentation';
import { UndoRedoService } from '../undo/undo-redo';
import { MediaFiles, type MediaFile, type MediaFileId } from '../media-files/media-files';
import { signal } from '@angular/core';
import { type AutoSegmentationModel, type AutoSegmentationResult } from './auto-segmentation-model.interface';
import { type VideoLandmarksData } from '../landmark-extraction/landmark-data.interface';

describe('AutoSegmentationService', () => {
  let service: AutoSegmentationService;
  let mockLandmarkExtraction: {
    extractLandmarks: ReturnType<typeof vi.fn>,
    hasCachedLandmarks: ReturnType<typeof vi.fn>,
    getCachedLandmarks: ReturnType<typeof vi.fn>,
    cancelActiveExtraction: ReturnType<typeof vi.fn>,
  };
  let mockVideoSegmentation: {
    applyAutoSegments: ReturnType<typeof vi.fn>,
    segments: ReturnType<typeof signal<VideoSegment[]>>,
    correlationOrder: ReturnType<typeof signal<readonly string[]>>,
  };
  let mockUndoRedo: {
    execute: ReturnType<typeof vi.fn>,
  };
  let mockMediaFiles: {
    mediaFiles: ReturnType<typeof signal<MediaFile[]>>,
  };

  const sampleFile: MediaFile = {
    id: 'media-file-1' as MediaFileId,
    file: new File([], 'video.mp4'),
    name: 'video.mp4',
    url: 'blob:video',
    thumbnail: null,
  };

  const dummyLandmarksData: VideoLandmarksData = {
    mediaFileId: sampleFile.id,
    duration: 10,
    framerate: 5,
    sampledTimestamps: [0, 0.2, 0.4],
    landmarks: [],
  };

  beforeEach(() => {
    mockLandmarkExtraction = {
      extractLandmarks: vi.fn().mockResolvedValue(dummyLandmarksData),
      hasCachedLandmarks: vi.fn().mockReturnValue(false),
      getCachedLandmarks: vi.fn().mockReturnValue(null),
      cancelActiveExtraction: vi.fn(),
    };

    mockVideoSegmentation = {
      applyAutoSegments: vi.fn().mockReturnValue({
        beforeSegments: [],
        beforeCorrelationOrder: [],
      }),
      segments: signal<VideoSegment[]>([]),
      correlationOrder: signal<readonly string[]>([]),
    };

    mockUndoRedo = {
      execute: vi.fn(),
    };

    mockMediaFiles = {
      mediaFiles: signal<MediaFile[]>([sampleFile]),
    };

    TestBed.configureTestingModule({
      providers: [
        AutoSegmentationService,
        { provide: LandmarkExtractionService, useValue: mockLandmarkExtraction },
        { provide: VideoSegmentationService, useValue: mockVideoSegmentation },
        { provide: UndoRedoService, useValue: mockUndoRedo },
        { provide: MediaFiles, useValue: mockMediaFiles },
      ],
    });

    service = TestBed.inject(AutoSegmentationService);
  });

  it('should be created with default settings', () => {
    expect(service).toBeTruthy();
    expect(service.lambda()).toBe(1.0);
    expect(service.selectedModelId()).toBe('wrist-vertical-advantage');
    expect(service.isProcessing()).toBe(false);
  });

  it('should clamp lambda values to valid bounds [0, 2]', () => {
    service.setLambda(2.5);
    expect(service.lambda()).toBe(2.0);

    service.setLambda(-0.5);
    expect(service.lambda()).toBe(0.0);

    service.setLambda(1.234);
    expect(service.lambda()).toBe(1.23);
  });

  it('should register and switch to custom models', () => {
    const customModel: AutoSegmentationModel = {
      id: 'custom-model',
      name: 'Custom Heuristic Model',
      description: 'Model for testing registration',
      segment: vi.fn().mockReturnValue({
        activeRegions: [[1, 3]],
        segments: [{ startTime: 1, endTime: 3 }],
      } as AutoSegmentationResult),
    };

    service.registerModel(customModel);
    expect(service.models().some((m) => m.id === 'custom-model')).toBe(true);

    service.selectModel('custom-model');
    expect(service.selectedModelId()).toBe('custom-model');
    expect(service.selectedModel().id).toBe('custom-model');
  });

  it('should run auto-segmentation, apply cuts, and record undo command', async () => {
    await service.runAutoSegmentation(sampleFile.id);

    expect(mockLandmarkExtraction.extractLandmarks).toHaveBeenCalledWith(
      sampleFile,
      expect.objectContaining({
        forceReextract: undefined,
      }),
    );
    expect(mockVideoSegmentation.applyAutoSegments).toHaveBeenCalled();
    expect(mockUndoRedo.execute).toHaveBeenCalled();
    expect(service.isProcessing()).toBe(false);
  });

  it('should throw an error when attempting auto-segmentation on non-existent media file', async () => {
    await expect(service.runAutoSegmentation('non-existent' as MediaFileId)).rejects.toThrow(
      'Media file with ID non-existent not found.',
    );
  });

  it('should recalculate segments in real time when landmarks are cached and lambda changes', () => {
    mockLandmarkExtraction.getCachedLandmarks.mockReturnValue(dummyLandmarksData);

    service.recalculateWithLambda(sampleFile.id, 1.4);

    expect(service.lambda()).toBe(1.4);
    expect(mockVideoSegmentation.applyAutoSegments).toHaveBeenCalled();
    expect(mockUndoRedo.execute).toHaveBeenCalled();
  });

  it('should cancel active processing when cancel() is invoked', () => {
    service.cancel();
    expect(mockLandmarkExtraction.cancelActiveExtraction).toHaveBeenCalled();
    expect(service.isProcessing()).toBe(false);
  });
});

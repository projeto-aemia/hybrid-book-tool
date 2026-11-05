import { TestBed } from '@angular/core/testing';
import { LandmarkExtractionService } from './landmark-extraction';
import { type MediaFile, type MediaFileId } from '../media-files/media-files';
import { PLATFORM_ID } from '@angular/core';

describe('LandmarkExtractionService', () => {
  let service: LandmarkExtractionService;

  const sampleFile: MediaFile = {
    id: 'test-media-1' as MediaFileId,
    file: new File([new Uint8Array([0, 1, 2, 3])], 'sample.mp4', { type: 'video/mp4' }),
    name: 'sample.mp4',
    url: 'blob:sample',
    thumbnail: null,
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        LandmarkExtractionService,
        { provide: PLATFORM_ID, useValue: 'browser' },
      ],
    });

    service = TestBed.inject(LandmarkExtractionService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should report false for hasCachedLandmarks initially', () => {
    expect(service.hasCachedLandmarks(sampleFile.id)).toBe(false);
    expect(service.getCachedLandmarks(sampleFile.id)).toBeUndefined();
  });

  it('should allow clearing cached landmarks for specific file or all files', () => {
    service.clearCache(sampleFile.id);
    service.clearCache();
    expect(service.hasCachedLandmarks(sampleFile.id)).toBe(false);
  });

  it('should cancel active extraction when cancelActiveExtraction is called', () => {
    expect(() => {
      service.cancelActiveExtraction();
    }).not.toThrow();
  });

  it('should throw an error when running in SSR / non-browser platform', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LandmarkExtractionService,
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });

    const serverService = TestBed.inject(LandmarkExtractionService);
    await expect(serverService.extractLandmarks(sampleFile)).rejects.toThrow(
      'Landmark extraction can only be performed in a browser environment.',
    );
  });
});

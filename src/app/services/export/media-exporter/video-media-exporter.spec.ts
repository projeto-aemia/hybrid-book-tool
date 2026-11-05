import { describe, it, expect } from 'vitest';
import {
  VideoMediaExporter,
  formatSeconds,
  detectFormatFromFileName,
} from './video-media-exporter';
import { MediaExporterRegistry } from './media-exporter-registry';
import { MediaFormatExporter, MediaExportContext } from './media-exporter.interface';
import { MediaFile, MediaFileId } from '../../media-files/media-files';
import { VideoSegment } from '../../video-segmentation/video-segmentation';
import { XmlElement } from '../xml/xml-builder';

describe('video-media-exporter', () => {
  describe('formatSeconds', () => {
    it('should format whole numbers as integers', () => {
      expect(formatSeconds(0)).toBe('0');
      expect(formatSeconds(15)).toBe('15');
    });

    it('should format decimal numbers with up to 3 decimal places', () => {
      expect(formatSeconds(12.3456)).toBe('12.346');
      expect(formatSeconds(5.5)).toBe('5.5');
    });

    it('should handle negative or non-finite numbers safely', () => {
      expect(formatSeconds(-5)).toBe('0');
      expect(formatSeconds(NaN)).toBe('0');
      expect(formatSeconds(Infinity)).toBe('0');
    });
  });

  describe('detectFormatFromFileName', () => {
    it('should return uppercase extension', () => {
      expect(detectFormatFromFileName('clip.mp4')).toBe('MP4');
      expect(detectFormatFromFileName('clip.webm')).toBe('WEBM');
    });

    it('should fallback to MP4 if no extension is present', () => {
      expect(detectFormatFromFileName('video_file')).toBe('MP4');
    });
  });

  describe('VideoMediaExporter', () => {
    const exporter = new VideoMediaExporter();

    it('should export video media XML and file entries', async () => {
      const dummyFile1 = new File(['dummy-video-content-1'], 'video1.mp4', { type: 'video/mp4' });
      const dummyFile2 = new File(['dummy-video-content-2'], 'video2.mp4', { type: 'video/mp4' });

      const mediaFiles: MediaFile[] = [
        {
          id: 'media-1' as MediaFileId,
          file: dummyFile1,
          name: 'video1.mp4',
          url: null,
          thumbnail: null,
        },
        {
          id: 'media-2' as MediaFileId,
          file: dummyFile2,
          name: 'video2.mp4',
          url: null,
          thumbnail: null,
        },
      ];

      const phrases = [
        {
          phraseId: 1,
          segment: {
            id: 'seg-1',
            fileId: 'media-1' as MediaFileId,
            name: 'Segment 1',
            startTime: 0,
            endTime: 5.5,
            thumbnail: null,
          } as VideoSegment,
        },
        {
          phraseId: 2,
          segment: {
            id: 'seg-2',
            fileId: 'media-1' as MediaFileId,
            name: 'Segment 2',
            startTime: 5.5,
            endTime: 12.0,
            thumbnail: null,
          } as VideoSegment,
        },
        {
          phraseId: 3,
          segment: {
            id: 'seg-3',
            fileId: 'media-2' as MediaFileId,
            name: 'Segment 3',
            startTime: 0,
            endTime: 7.2,
            thumbnail: null,
          } as VideoSegment,
        },
      ];

      const context: MediaExportContext<VideoSegment> = {
        phrases,
        mediaFiles,
        groupName: 'video_group',
      };

      const result = await exporter.exportMedia(context);

      expect(result.setDefinition).toEqual({
        title: 'video',
        mediaGroup: 'video_group',
      });

      expect(result.files.length).toBe(2);
      expect(result.files[0].path).toBe('video/video1.mp4');
      expect(result.files[1].path).toBe('video/video2.mp4');

      const mediaXml = result.mediaElement.toXmlString();
      expect(mediaXml).toContain('<media type="video" format="MP4" group="video_group">');
      expect(mediaXml).toContain('<file name="video1.mp4" from="1" to="2">');
      expect(mediaXml).toContain('<phrase id="1" start="0" end="5.5" />');
      expect(mediaXml).toContain('<phrase id="2" start="5.5" end="12" />');
      expect(mediaXml).toContain('<file name="video2.mp4" from="3" to="3">');
      expect(mediaXml).toContain('<phrase id="3" start="0" end="7.2" />');
    });

    it('should sanitize video filenames with path traversal', async () => {
      const dummyFile = new File(['content'], '../../malicious.mp4', { type: 'video/mp4' });
      const mediaFiles: MediaFile[] = [
        {
          id: 'media-traversal' as MediaFileId,
          file: dummyFile,
          name: '../../malicious.mp4',
          url: null,
          thumbnail: null,
        },
      ];

      const segment: VideoSegment = {
        id: 'seg-1',
        fileId: 'media-traversal' as MediaFileId,
        name: 'Segment 1',
        startTime: 0,
        endTime: 5,
        thumbnail: null,
      };

      const result = await exporter.exportMedia({
        phrases: [{ phraseId: 1, segment }],
        mediaFiles,
        groupName: 'video_group',
      });

      expect(result.files[0].path).toBe('video/malicious.mp4');
      const xml = result.mediaElement.toXmlString();
      expect(xml).toContain('<file name="malicious.mp4"');
    });
  });

  describe('MediaExporterRegistry', () => {
    it('should have VideoMediaExporter registered by default', () => {
      const registry = new MediaExporterRegistry();
      expect(registry.get('video')).toBeInstanceOf(VideoMediaExporter);
      expect(registry.getAll().length).toBe(1);
    });

    it('should allow registering and retrieving custom media exporters', () => {
      const registry = new MediaExporterRegistry();
      const mockAudioExporter: MediaFormatExporter = {
        mediaType: 'audio',
        defaultGroupName: 'audio_group',
        defaultSetTitle: 'audio',
        exportMedia: async () => ({
          mediaElement: new XmlElement('media', { type: 'audio' }),
          files: [],
          setDefinition: { title: 'audio', mediaGroup: 'audio_group' },
        }),
      };

      registry.register(mockAudioExporter);
      expect(registry.get('audio')).toBe(mockAudioExporter);
      expect(registry.getAll().length).toBe(2);

      registry.unregister('audio');
      expect(registry.get('audio')).toBeUndefined();
    });
  });
});

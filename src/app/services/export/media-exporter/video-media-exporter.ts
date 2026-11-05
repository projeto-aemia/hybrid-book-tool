import { sanitizeEntryFileName } from '../export-path-sanitizer';
import { XmlElement } from '../xml/xml-builder';
import { ExportFileEntry } from '../text-exporter/text-exporter.interface';
import { MediaFile } from '../../media-files/media-files';
import { VideoSegment } from '../../video-segmentation/video-segmentation';
import {
  CorrelatedMediaPhrase,
  HybridBookSetDefinition,
  MediaExportContext,
  MediaExportResult,
  MediaFormatExporter,
} from './media-exporter.interface';

/**
 * Formats a timestamp in seconds to a string with at most 3 decimal places.
 *
 * @param seconds The timestamp in seconds.
 * @returns Formatted numeric string.
 */
export function formatSeconds(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) {
    return '0';
  }
  const rounded = Number(seconds.toFixed(3));
  return rounded.toString();
}

/**
 * Detects the media format identifier from a file name extension.
 *
 * @param fileName The media file name.
 * @returns The uppercase format name, defaulting to 'MP4'.
 */
export function detectFormatFromFileName(fileName: string): string {
  const extension = fileName.split('.').pop();
  if (extension && extension !== fileName) {
    return extension.toUpperCase();
  }
  return 'MP4';
}

/**
 * Video media format exporter for Hybrid Book 3.0 packages.
 */
export class VideoMediaExporter implements MediaFormatExporter<VideoSegment> {
  public readonly mediaType = 'video';
  public readonly defaultGroupName = 'video_group';
  public readonly defaultSetTitle = 'video';

  /**
   * Exports video phrases and files into a synchronization media XML node and zip entries.
   *
   * @param context The media export context containing correlated video phrases and media files.
   * @returns A promise resolving to the media export result.
   */
  public async exportMedia(context: MediaExportContext<VideoSegment>): Promise<MediaExportResult> {
    const filesMap = new Map<string, {
      mediaFile: MediaFile,
      phrases: CorrelatedMediaPhrase<VideoSegment>[],
    }>();

    for (const phrase of context.phrases) {
      const fileId = phrase.segment.fileId;
      const mediaFile = context.mediaFiles.find((f) => f.id === fileId);
      if (!mediaFile) {
        continue;
      }

      const existing = filesMap.get(fileId);
      if (existing) {
        existing.phrases.push(phrase);
      } else {
        filesMap.set(fileId, {
          mediaFile,
          phrases: [phrase],
        });
      }
    }

    const firstMediaFile = context.mediaFiles[0];
    const overallFormat = firstMediaFile ? detectFormatFromFileName(firstMediaFile.name) : 'MP4';

    const mediaElement = new XmlElement('media', {
      type: this.mediaType,
      format: overallFormat,
      group: context.groupName,
    });

    const filesElement = new XmlElement('files');
    const filesToPackage: ExportFileEntry[] = [];

    for (const { mediaFile, phrases } of filesMap.values()) {
      if (phrases.length === 0) {
        continue;
      }

      const phraseIds = phrases.map((p) => p.phraseId);
      const minPhrase = Math.min(...phraseIds);
      const maxPhrase = Math.max(...phraseIds);
      const fileName = sanitizeEntryFileName(mediaFile.name, 'video.mp4');

      const fileElement = new XmlElement('file', {
        name: fileName,
        from: minPhrase,
        to: maxPhrase,
      });

      for (const phrase of phrases) {
        fileElement.addChild(new XmlElement('phrase', {
          id: phrase.phraseId,
          start: formatSeconds(phrase.segment.startTime),
          end: formatSeconds(phrase.segment.endTime),
        }));
      }

      filesElement.addChild(fileElement);

      const entryPath = `video/${fileName}`;
      const alreadyAdded = filesToPackage.some((entry) => entry.path === entryPath);
      if (!alreadyAdded) {
        filesToPackage.push({
          path: entryPath,
          content: mediaFile.file,
          fallbackUrl: mediaFile.url,
        });
      }
    }

    mediaElement.addChild(filesElement);

    const setDefinition: HybridBookSetDefinition = {
      title: this.defaultSetTitle,
      mediaGroup: context.groupName,
    };

    return {
      mediaElement,
      files: filesToPackage,
      setDefinition,
    };
  }
}

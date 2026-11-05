import {
  ZipWriter,
  BlobWriter,
  BlobReader,
  TextReader,
  Uint8ArrayReader,
  type Reader,
} from '@zip.js/zip.js';
import { ExportFileEntry } from '../text-exporter/text-exporter.interface';
import { sanitizeZipPath, sanitizeDownloadFileName } from '../export-path-sanitizer';

/**
 * Service responsible for packaging export file entries into a ZIP archive and saving or downloading them.
 * Utilizes streaming and zero-recompression for media files to minimize memory consumption when processing large books.
 */
export class ZipPackager {
  /**
   * Packages file entries and saves the resulting archive.
   * If the File System Access API (showSaveFilePicker) is supported by the browser, streams chunks
   * directly to the target file on disk to maintain minimal memory usage for large files.
   * Otherwise, falls back to generating a memory Blob and triggering a standard browser download.
   *
   * @param entries List of file entries containing relative paths and file contents.
   * @param fileName Suggested file name for the downloaded ZIP file.
   * @param onProgress Optional callback receiving the overall export progress ratio from 0.0 to 1.0.
   * @returns A promise resolving to the generated Blob when falling back, or void when directly streamed to disk.
   */
  public async packageAndSave(
    entries: readonly ExportFileEntry[],
    fileName: string,
    onProgress?: (progressRatio: number) => void
  ): Promise<Blob | void> {
    const safeFileName = sanitizeDownloadFileName(fileName);
    if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      try {
        const picker = (
          window as unknown as {
            showSaveFilePicker: (options?: {
              suggestedName?: string,
              types?: {
                description?: string,
                accept: Record<string, string[]>,
              }[],
            }) => Promise<FileSystemFileHandle>,
          }
        ).showSaveFilePicker;

        const handle = await picker({
          suggestedName: safeFileName,
          types: [
            {
              description: 'ZIP Archive',
              accept: { 'application/zip': ['.zip'] },
            },
          ],
        });

        const writableStream = await handle.createWritable();
        const zipWriter = new ZipWriter(writableStream, { zip64: true });

        await this.writeEntries(zipWriter, entries, onProgress);
        return;
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('Exportação cancelada pelo usuário.', { cause: error });
        }

        // Fallback to Blob download if showSaveFilePicker failed due to permission or context
      }
    }

    const blob = await this.createZipBlob(entries, onProgress);
    this.triggerDownload(blob, safeFileName);
    return blob;
  }

  /**
   * Packages file entries into a compressed ZIP archive Blob using streaming writers.
   *
   * @param entries List of file entries containing relative paths and file contents.
   * @param onProgress Optional callback receiving the overall export progress ratio from 0.0 to 1.0.
   * @returns A promise resolving to the compressed ZIP Blob.
   */
  public async createZipBlob(
    entries: readonly ExportFileEntry[],
    onProgress?: (progressRatio: number) => void
  ): Promise<Blob> {
    const blobWriter = new BlobWriter('application/zip');
    const zipWriter = new ZipWriter(blobWriter, { zip64: true });

    return await this.writeEntries(zipWriter, entries, onProgress);
  }

  /**
   * Writes all file entries into the provided ZipWriter while tracking sub-file chunk progress.
   *
   * @param zipWriter The ZipWriter instance receiving file entries.
   * @param entries List of file entries to write.
   * @param onProgress Optional callback receiving the overall export progress ratio.
   * @returns The resolved data produced by closing the ZipWriter.
   */
  private async writeEntries<T>(
    zipWriter: ZipWriter<T>,
    entries: readonly ExportFileEntry[],
    onProgress?: (progressRatio: number) => void
  ): Promise<T> {
    const totalBytes = entries.reduce((acc, entry) => acc + this.getEntrySize(entry), 0);
    let completedBytes = 0;

    if (onProgress) {
      onProgress(0);
    }

    for (const entry of entries) {
      const safePath = sanitizeZipPath(entry.path);
      const entrySize = this.getEntrySize(entry);
      const { reader, level } = await this.getEntryReader(entry);

      await zipWriter.add(safePath, reader, {
        level,
        onprogress: (loaded: number) => {
          if (onProgress && totalBytes > 0) {
            const currentTotal = completedBytes + loaded;
            const ratio = Math.min(1, currentTotal / totalBytes);
            onProgress(ratio);
          }
        },
      });

      completedBytes += entrySize;
      if (onProgress && totalBytes > 0) {
        onProgress(Math.min(1, completedBytes / totalBytes));
      }
    }

    const result = await zipWriter.close();

    if (onProgress) {
      onProgress(1);
    }

    return result;
  }

  /**
   * Estimates uncompressed size of a file entry in bytes for progress calculation.
   *
   * @param entry The export file entry.
   * @returns Uncompressed size in bytes.
   */
  private getEntrySize(entry: ExportFileEntry): number {
    if (typeof entry.content === 'string') {
      return new TextEncoder().encode(entry.content).length;
    }

    if (entry.content instanceof Uint8Array || ArrayBuffer.isView(entry.content)) {
      return entry.content.byteLength;
    }

    if (
      entry.content instanceof ArrayBuffer ||
      Object.prototype.toString.call(entry.content) === '[object ArrayBuffer]'
    ) {
      return (entry.content as ArrayBuffer).byteLength;
    }

    if (entry.content instanceof Blob || typeof (entry.content as Blob)?.size === 'number') {
      return (entry.content as Blob).size;
    }

    return 0;
  }

  /**
   * Resolves the appropriate reader and compression level for a file entry.
   * Media files are stored uncompressed (level 0) to avoid memory and CPU overhead.
   *
   * @param entry The export file entry.
   * @returns An object containing the Zip reader and compression level.
   */
  private async getEntryReader(entry: ExportFileEntry): Promise<{ reader: Reader<unknown>, level: number }> {
    const isMedia = entry.path.startsWith('video/') || entry.path.startsWith('audio/');
    const level = isMedia ? 0 : 6;

    if (typeof entry.content === 'string') {
      return { reader: new TextReader(entry.content), level };
    }

    if (entry.content instanceof Uint8Array) {
      return { reader: new Uint8ArrayReader(entry.content), level };
    }

    if (ArrayBuffer.isView(entry.content)) {
      const view = entry.content;
      const uint8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      return { reader: new Uint8ArrayReader(uint8), level };
    }

    if (
      entry.content instanceof ArrayBuffer ||
      Object.prototype.toString.call(entry.content) === '[object ArrayBuffer]'
    ) {
      return { reader: new Uint8ArrayReader(new Uint8Array(entry.content as ArrayBuffer)), level };
    }

    if (entry.content instanceof Blob || typeof (entry.content as Blob)?.size === 'number') {
      const resolvedBlob = await this.resolveBlob(entry, entry.content as Blob);
      return { reader: new BlobReader(resolvedBlob), level };
    }

    throw new Error('Tipo de conteúdo não suportado para entrada ZIP.');
  }

  /**
   * Validates and resolves a Blob/File entry, gracefully recovering via fallbackUrl if the browser
   * invalidated the underlying OS file handle (e.g. Chromium NotReadableError with OneDrive files).
   *
   * @param entry The export file entry.
   * @param blob The Blob or File to validate.
   * @returns The resolved readable Blob.
   */
  private async resolveBlob(entry: ExportFileEntry, blob: Blob): Promise<Blob> {
    try {
      if (typeof blob.slice === 'function') {
        await blob.slice(0, 1).arrayBuffer();
      } else {
        await blob.arrayBuffer();
      }
      return blob;
    } catch (firstError) {
      if (entry.fallbackUrl) {
        try {
          const response = await fetch(entry.fallbackUrl);
          if (response.ok) {
            return await response.blob();
          }
        } catch {
          // Fallback URL fetch failed, rethrow original error
        }
      }

      throw firstError;
    }
  }

  /**
   * Triggers a browser file download for a given Blob.
   *
   * @param blob The blob to trigger download for.
   * @param fileName The desired download file name.
   */
  public triggerDownload(blob: Blob, fileName: string): void {
    const safeFileName = sanitizeDownloadFileName(fileName);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeFileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

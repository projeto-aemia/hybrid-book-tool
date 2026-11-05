import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZipPackager } from './zip-packager';
import { ExportFileEntry } from '../text-exporter/text-exporter.interface';
import { ZipReader, BlobReader, TextWriter } from '@zip.js/zip.js';

describe('ZipPackager', () => {
  let packager: ZipPackager;

  beforeEach(() => {
    packager = new ZipPackager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function readEntryText(blob: Blob, path: string): Promise<string | undefined> {
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();
    const entry = entries.find((item) => item.filename === path);
    if (!entry || !('getData' in entry)) {
      await reader.close();
      return undefined;
    }
    const fileEntry = entry as { getData: (writer: TextWriter) => Promise<string> };
    const text = await fileEntry.getData(new TextWriter());
    await reader.close();
    return text;
  }

  describe('createZipBlob', () => {
    it('should create a valid ZIP blob with string, Uint8Array and ArrayBuffer entries', async () => {
      const entries: ExportFileEntry[] = [
        { path: 'book.xml', content: '<book><title>Teste</title></book>' },
        { path: 'text/sample.txt', content: new TextEncoder().encode('Conteúdo texto') },
        { path: 'data.bin', content: new Uint8Array([65, 66, 67]).buffer },
      ];

      const blob = await packager.createZipBlob(entries);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);

      const bookXml = await readEntryText(blob, 'book.xml');
      const sampleText = await readEntryText(blob, 'text/sample.txt');
      const dataBin = await readEntryText(blob, 'data.bin');

      expect(bookXml).toBe('<book><title>Teste</title></book>');
      expect(sampleText).toBe('Conteúdo texto');
      expect(dataBin).toBe('ABC');
    });

    it('should resolve normal File/Blob entries directly', async () => {
      const file = new File(['conteúdo do arquivo'], 'doc.pdf', { type: 'application/pdf' });
      const entries: ExportFileEntry[] = [
        { path: 'text/doc.pdf', content: file },
      ];

      const blob = await packager.createZipBlob(entries);
      const text = await readEntryText(blob, 'text/doc.pdf');

      expect(text).toBe('conteúdo do arquivo');
    });

    it('should sanitize entry paths to prevent path traversal in zip archive', async () => {
      const entries: ExportFileEntry[] = [
        { path: 'text/../../escape.txt', content: 'safe content' },
      ];

      const blob = await packager.createZipBlob(entries);
      const text = await readEntryText(blob, 'escape.txt');
      expect(text).toBe('safe content');
    });

    it('should fallback to fallbackUrl when File reading throws NotReadableError', async () => {
      const mockFile = new File(['falha original'], 'video.mp4', { type: 'video/mp4' });
      const notReadableError = new DOMException(
        'The requested file could not be read, typically due to permission problems that ' +
        'have occurred after a reference to a file was acquired.',
        'NotReadableError'
      );
      vi.spyOn(mockFile, 'slice').mockImplementation(() => {
        throw notReadableError;
      });

      const fallbackBlob = new Blob(['conteúdo recuperado via fallback url'], { type: 'video/mp4' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => fallbackBlob,
      } as Response);

      const entries: ExportFileEntry[] = [
        {
          path: 'video/video.mp4',
          content: mockFile,
          fallbackUrl: 'blob:http://localhost:4200/dummy-video-uuid',
        },
      ];

      const blob = await packager.createZipBlob(entries);
      expect(fetchSpy).toHaveBeenCalledWith('blob:http://localhost:4200/dummy-video-uuid');

      const content = await readEntryText(blob, 'video/video.mp4');
      expect(content).toBe('conteúdo recuperado via fallback url');
    });

    it('should rethrow original error if all fallback strategies fail', async () => {
      const mockFile = new File(['dummy-bytes'], 'err.bin');
      const permError = new Error('Permission denied permanently');
      vi.spyOn(mockFile, 'slice').mockImplementation(() => {
        throw permError;
      });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fetch failed'));

      const entries: ExportFileEntry[] = [
        { path: 'err.bin', content: mockFile },
      ];

      await expect(packager.createZipBlob(entries)).rejects.toThrow('Permission denied permanently');
    });

    it('should emit progress updates during createZipBlob', async () => {
      const entries: ExportFileEntry[] = [
        { path: 'book.xml', content: '<book><title>Teste</title></book>' },
        { path: 'file.txt', content: 'conteudo de teste' },
      ];

      const progressSpy = vi.fn();
      await packager.createZipBlob(entries, progressSpy);

      expect(progressSpy).toHaveBeenCalled();
      expect(progressSpy).toHaveBeenCalledWith(0);
      expect(progressSpy).toHaveBeenLastCalledWith(1);
    });
  });

  describe('packageAndSave', () => {
    it('should stream to disk when showSaveFilePicker is available', async () => {
      const writtenChunks: Uint8Array[] = [];
      const mockWritable = new WritableStream<Uint8Array>({
        write(chunk) {
          writtenChunks.push(chunk);
        },
      });

      const mockHandle = {
        createWritable: vi.fn().mockResolvedValue(mockWritable),
      };

      const mockPicker = vi.fn().mockResolvedValue(mockHandle);
      (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = mockPicker;

      const entries: ExportFileEntry[] = [
        { path: 'book.xml', content: '<book />' },
      ];

      const result = await packager.packageAndSave(entries, 'meu_livro.zip');

      expect(mockPicker).toHaveBeenCalledWith({
        suggestedName: 'meu_livro.zip',
        types: [
          {
            description: 'ZIP Archive',
            accept: { 'application/zip': ['.zip'] },
          },
        ],
      });
      expect(mockHandle.createWritable).toHaveBeenCalled();
      expect(writtenChunks.length).toBeGreaterThan(0);
      expect(result).toBeUndefined();

      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });

    it('should throw friendly error when user aborts file picker', async () => {
      const abortError = new DOMException('User cancelled', 'AbortError');
      const mockPicker = vi.fn().mockRejectedValue(abortError);
      (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = mockPicker;

      const entries: ExportFileEntry[] = [{ path: 'book.xml', content: '<book />' }];

      await expect(packager.packageAndSave(entries, 'livro.zip')).rejects.toThrow(
        'Exportação cancelada pelo usuário.'
      );

      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });

    it('should fallback to createZipBlob and triggerDownload when showSaveFilePicker is unavailable', async () => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;

      const triggerDownloadSpy = vi.spyOn(packager, 'triggerDownload').mockReturnValue();

      const entries: ExportFileEntry[] = [
        { path: 'book.xml', content: '<book />' },
      ];

      const result = await packager.packageAndSave(entries, 'fallback.zip');

      expect(result).toBeInstanceOf(Blob);
      expect(triggerDownloadSpy).toHaveBeenCalledWith(expect.any(Blob), 'fallback.zip');
    });

    it('should emit progress updates during packageAndSave', async () => {
      const writtenChunks: Uint8Array[] = [];
      const mockWritable = new WritableStream<Uint8Array>({
        write(chunk) {
          writtenChunks.push(chunk);
        },
      });

      const mockHandle = {
        createWritable: vi.fn().mockResolvedValue(mockWritable),
      };

      const mockPicker = vi.fn().mockResolvedValue(mockHandle);
      (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = mockPicker;

      const entries: ExportFileEntry[] = [
        { path: 'book.xml', content: '<book />' },
      ];

      const progressSpy = vi.fn();
      await packager.packageAndSave(entries, 'progress.zip', progressSpy);

      expect(progressSpy).toHaveBeenCalledWith(0);
      expect(progressSpy).toHaveBeenLastCalledWith(1);

      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
  });

  describe('triggerDownload', () => {
    it('should create an anchor element, set download name, and trigger click', () => {
      const dummyBlob = new Blob(['teste'], { type: 'application/zip' });
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:dummy-zip-url');
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue();

      let clicked = false;
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
        const el = originalCreateElement(tagName);
        if (tagName === 'a') {
          el.click = () => {
            clicked = true;
          };
        }
        return el;
      });

      packager.triggerDownload(dummyBlob, 'livro_teste.zip');

      expect(createObjectURLSpy).toHaveBeenCalledWith(dummyBlob);
      expect(clicked).toBe(true);
      expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    });

    it('should sanitize download filename', () => {
      const dummyBlob = new Blob(['teste'], { type: 'application/zip' });
      let assignedDownload = '';
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
        const el = originalCreateElement(tagName);
        if (tagName === 'a') {
          Object.defineProperty(el, 'download', {
            set: (val: string) => {
              assignedDownload = val;
            },
            get: () => assignedDownload,
          });
          el.click = () => undefined;
        }
        return el;
      });

      packager.triggerDownload(dummyBlob, '../../livro\r\nhibrido.zip');
      expect(assignedDownload).toBe('livrohibrido.zip');
    });
  });
});

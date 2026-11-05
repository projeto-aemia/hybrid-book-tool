import { describe, it, expect } from 'vitest';
import {
  sanitizeEntryFileName,
  sanitizeZipPath,
  sanitizeDownloadFileName,
} from './export-path-sanitizer';

describe('export-path-sanitizer', () => {
  describe('sanitizeEntryFileName', () => {
    it('should keep normal valid file names untouched', () => {
      expect(sanitizeEntryFileName('document.pdf', 'fallback.pdf')).toBe('document.pdf');
      expect(sanitizeEntryFileName('video_01.mp4', 'fallback.mp4')).toBe('video_01.mp4');
      expect(sanitizeEntryFileName('apresentação (final).webm', 'fallback.webm')).toBe('apresentação (final).webm');
    });

    it('should strip directory components to prevent path traversal', () => {
      expect(sanitizeEntryFileName('../../escape.pdf', 'fallback.pdf')).toBe('escape.pdf');
      expect(sanitizeEntryFileName('..\\..\\win_escape.mp4', 'fallback.mp4')).toBe('win_escape.mp4');
      expect(sanitizeEntryFileName('/root/sub/document.pdf', 'fallback.pdf')).toBe('document.pdf');
      expect(sanitizeEntryFileName('C:\\Windows\\System32\\cmd.exe', 'fallback.exe')).toBe('cmd.exe');
    });

    it('should strip illegal filesystem and control characters', () => {
      expect(sanitizeEntryFileName('doc<1>:test*?.pdf', 'fallback.pdf')).toBe('doc1test.pdf');
      expect(sanitizeEntryFileName('name\x00with\x1fnull.pdf', 'fallback.pdf')).toBe('namewithnull.pdf');
    });

    it('should strip leading dots and return fallback for dot-only or empty names', () => {
      expect(sanitizeEntryFileName('..', 'fallback.pdf')).toBe('fallback.pdf');
      expect(sanitizeEntryFileName('.', 'fallback.pdf')).toBe('fallback.pdf');
      expect(sanitizeEntryFileName('', 'fallback.pdf')).toBe('fallback.pdf');
      expect(sanitizeEntryFileName('   ', 'fallback.pdf')).toBe('fallback.pdf');
      expect(sanitizeEntryFileName('...test.pdf', 'fallback.pdf')).toBe('test.pdf');
    });
  });

  describe('sanitizeZipPath', () => {
    it('should keep standard relative paths untouched', () => {
      expect(sanitizeZipPath('text/document.pdf')).toBe('text/document.pdf');
      expect(sanitizeZipPath('video/clip.mp4')).toBe('video/clip.mp4');
      expect(sanitizeZipPath('book.xml')).toBe('book.xml');
    });

    it('should prevent path traversal sequences from escaping root', () => {
      expect(sanitizeZipPath('text/../../escape.txt')).toBe('escape.txt');
      expect(sanitizeZipPath('../../escape.txt')).toBe('escape.txt');
      expect(sanitizeZipPath('video/../text/sample.pdf')).toBe('text/sample.pdf');
    });

    it('should normalize Windows backslashes and strip leading slashes', () => {
      expect(sanitizeZipPath('text\\sub\\doc.pdf')).toBe('text/sub/doc.pdf');
      expect(sanitizeZipPath('/etc/passwd')).toBe('etc/passwd');
      expect(sanitizeZipPath('\\Windows\\system.ini')).toBe('Windows/system.ini');
    });

    it('should strip control and illegal characters from segments', () => {
      expect(sanitizeZipPath('text/file<1>?:name.pdf')).toBe('text/file1name.pdf');
      expect(sanitizeZipPath('text/file\x00name.pdf')).toBe('text/filename.pdf');
    });

    it('should return fallback if path resolves to empty', () => {
      expect(sanitizeZipPath('../../')).toBe('file');
      expect(sanitizeZipPath('///')).toBe('file');
      expect(sanitizeZipPath('', 'fallback.bin')).toBe('fallback.bin');
    });
  });

  describe('sanitizeDownloadFileName', () => {
    it('should keep normal download file names', () => {
      expect(sanitizeDownloadFileName('livro_hibrido.zip')).toBe('livro_hibrido.zip');
    });

    it('should strip newlines and carriage returns', () => {
      expect(sanitizeDownloadFileName('livro\r\nhibrido.zip')).toBe('livrohibrido.zip');
    });

    it('should strip directory separators', () => {
      expect(sanitizeDownloadFileName('../../livro.zip')).toBe('livro.zip');
      expect(sanitizeDownloadFileName('..\\..\\livro.zip')).toBe('livro.zip');
    });

    it('should return fallback for empty or whitespace names', () => {
      expect(sanitizeDownloadFileName('', 'default.zip')).toBe('default.zip');
      expect(sanitizeDownloadFileName('   ', 'default.zip')).toBe('default.zip');
      expect(sanitizeDownloadFileName('..', 'default.zip')).toBe('default.zip');
    });
  });
});

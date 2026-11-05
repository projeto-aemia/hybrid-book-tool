import { describe, it, expect } from 'vitest';
import { PdfTextRecordExporter } from './pdf-text-exporter';
import { TextSegment } from '../../text-segmentation/text-segmentation';

describe('PdfTextRecordExporter', () => {
  const exporter = new PdfTextRecordExporter();

  it('should export text media XML and phrase map XML correctly', async () => {
    const dummyPdf = new File(['%PDF-1.4 dummy'], 'sample.pdf', { type: 'application/pdf' });

    const segments: TextSegment[] = [
      {
        sequentialId: 0,
        pdfJsId: 'p0',
        page: 1,
        text: 'Segment zero',
        excluded: false,
        linkedChildren: [],
      },
      {
        sequentialId: 1,
        pdfJsId: 'p1',
        page: 2,
        text: 'Segment one',
        excluded: false,
        linkedChildren: [
          {
            sequentialId: 2,
            pdfJsId: 'p2',
            page: 2,
            text: 'Segment two (child)',
            excluded: false,
            linkedChildren: [],
          },
        ],
      },
    ];

    const result = await exporter.exportText({
      file: dummyPdf,
      segments,
      groupName: 'video_group',
    });

    expect(result.totalPhrases).toBe(2);
    expect(result.files.length).toBe(2);
    expect(result.files[0].path).toBe('text/sample.pdf');
    expect(result.files[1].path).toBe('text/phrase_map.xml');

    const mediaXml = result.mediaElement.toXmlString();
    expect(mediaXml).toContain('<media type="text" format="PDF" group="video_group">');
    expect(mediaXml).toContain('<file name="sample.pdf" from="1" to="2" />');

    const phraseMapContent = result.files[1].content as string;
    expect(phraseMapContent).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(phraseMapContent).toContain('<!DOCTYPE book SYSTEM "pdf_phrase_map_1.0.0-schema.dtd">');
    expect(phraseMapContent).toContain('<phrase_map file="sample.pdf">');
    expect(phraseMapContent).toContain('<phrase id="1" page="1">');
    expect(phraseMapContent).toContain('<segment id="0" page="1" />');
    expect(phraseMapContent).toContain('<phrase id="2" page="2">');
    expect(phraseMapContent).toContain('<segment id="1" page="2" />');
    expect(phraseMapContent).toContain('<segment id="2" page="2" />');
  });

  it('should handle empty segments gracefully', async () => {
    const dummyPdf = new File(['%PDF-1.4 dummy'], 'empty.pdf', { type: 'application/pdf' });

    const result = await exporter.exportText({
      file: dummyPdf,
      segments: [],
      groupName: 'video_group',
    });

    expect(result.totalPhrases).toBe(0);
    const mediaXml = result.mediaElement.toXmlString();
    expect(mediaXml).toContain('<file name="empty.pdf" from="0" to="0" />');
  });

  it('should sanitize filename with path traversal characters', async () => {
    const dummyPdf = new File(['%PDF-1.4 dummy'], '../../malicious.pdf', { type: 'application/pdf' });

    const result = await exporter.exportText({
      file: dummyPdf,
      segments: [],
      groupName: 'video_group',
    });

    expect(result.files[0].path).toBe('text/malicious.pdf');
    const mediaXml = result.mediaElement.toXmlString();
    expect(mediaXml).toContain('<file name="malicious.pdf"');
    const phraseMapContent = result.files[1].content as string;
    expect(phraseMapContent).toContain('<phrase_map file="malicious.pdf"');
  });
});

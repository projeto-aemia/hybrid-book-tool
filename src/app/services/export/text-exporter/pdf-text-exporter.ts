import { sanitizeEntryFileName } from '../export-path-sanitizer';
import { XmlElement, XmlDocument } from '../xml/xml-builder';
import {
  ExportFileEntry,
  TextExportContext,
  TextExportResult,
  TextRecordExporter,
} from './text-exporter.interface';

/**
 * PDF text record exporter that packages the original PDF and creates an auxiliary phrase_map.xml.
 */
export class PdfTextRecordExporter implements TextRecordExporter {
  public readonly format = 'PDF';

  /**
   * Exports the PDF text record into a media XML description and zip file entries.
   *
   * @param context The text export context containing the PDF file and correlated segments.
   * @returns The generated media element, files, and phrase count.
   */
  public async exportText(context: TextExportContext): Promise<TextExportResult> {
    const totalPhrases = context.segments.length;
    const fromPhrase = totalPhrases > 0 ? 1 : 0;
    const toPhrase = totalPhrases > 0 ? totalPhrases : 0;
    const fileName = sanitizeEntryFileName(context.file.name, 'document.pdf');

    const mediaElement = new XmlElement('media', {
      type: 'text',
      format: this.format,
      group: context.groupName,
    });

    const filesElement = new XmlElement('files');
    filesElement.addChild(new XmlElement('file', {
      name: fileName,
      from: fromPhrase,
      to: toPhrase,
    }));
    mediaElement.addChild(filesElement);

    const phraseMapXml = this.generatePhraseMapXml(fileName, context);

    const files: ExportFileEntry[] = [
      {
        path: `text/${fileName}`,
        content: context.file,
        fallbackUrl: context.fallbackUrl,
      },
      {
        path: 'text/phrase_map.xml',
        content: phraseMapXml,
      },
    ];

    return {
      mediaElement,
      files,
      totalPhrases,
    };
  }

  /**
   * Generates the XML document mapping each phrase to its sequential marked content IDs.
   *
   * @param fileName The PDF document file name.
   * @param context The text export context.
   * @returns The serialized phrase_map.xml string.
   */
  private generatePhraseMapXml(fileName: string, context: TextExportContext): string {
    const root = new XmlElement('phrase_map', { file: fileName });

    context.segments.forEach((segment, index) => {
      const phraseId = index + 1;
      const phraseElement = new XmlElement('phrase', {
        id: phraseId,
        page: segment.page,
      });

      phraseElement.addChild(new XmlElement('segment', {
        id: segment.sequentialId,
        page: segment.page,
      }));

      for (const child of segment.linkedChildren) {
        phraseElement.addChild(new XmlElement('segment', {
          id: child.sequentialId,
          page: child.page,
        }));
      }

      root.addChild(phraseElement);
    });

    const doc = new XmlDocument(root, {
      doctype: '<!DOCTYPE book SYSTEM "pdf_phrase_map_1.0.0-schema.dtd">',
    });
    return doc.toString();
  }
}

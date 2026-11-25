import { Service, signal, inject } from '@angular/core';
import { type TextContent, type TextItem, type TextMarkedContent } from 'ngx-extended-pdf-viewer';
import { spaceExcludedCharacters } from './space-excluded-characters.json';
import { TextAutoSegmentationService } from '../text-auto-segmentation/text-auto-segmentation';

@Service()
export class TextSegmentationService {
  private readonly textAutoSegmentationService = inject(TextAutoSegmentationService, { optional: true });

  /**
   * The list of top-level text segments. Each segment may have linked child segments.
   */
  public readonly segments = signal<TextSegment[]>([]);

  /**
   * The current status of the text segmentation process.
   */
  public readonly status = signal<'idle' | 'loading' | 'success' | 'error'>('idle');

  /**
   * Characters that, when appearing at the start of a subsequent text item, cause the preceding trailing space to be
   * stripped.
   */
  public static readonly SPACE_EXCLUDED_CHARACTERS = spaceExcludedCharacters;

  /**
   * Set of PDF.js Marked Content IDs that are addressable as text segments.
   */
  private readonly addressableSegments = new Set<string>();

  /**
   * The IDs returned by PDF.js are an undocumented library implementation detail. They can reasonably be expected
   * to be unique and to correspond to element IDs in the PDF viewer DOM. However, their specific format is not
   * guaranteed to remain the same in the future, and their library-specific nature makes them highly unsuitable for
   * document encoding. Therefore, we use the sequential order the marked content appears in the document structure to
   * generate standard IDs suitable for the document encoding we are implementing. The sequential order is guaranteed to
   * be stable and consistent across different libraries and implementations, and it is not dependent on any specific
   * library implementation details, as long as the document structure is traversed in the standard order, which is a
   * reasonable expectation.
   */
  private sequentialIdCounter = 0;

  /**
   * Sets the status of the text segmentation service to 'loading'. This should be called when parts of the text
   * segmentation process that are not handled by the text segmentation service start being executed, such as when the
   * text content is being extracted from the PDF so that the text segmentation service status reflects the overall
   * status of the text segmentation process, not just the parts handled by the service itself.
   */
  public workUpcoming(): void {
    this.status.set('loading');
  }

  /**
   * Creates the segments for a text record from the text content taken from PDF.js.
   * 
   * @param content An array with the text content from PDF.js including Marked Content for each page of the PDF.
   */
  public segmentText(content: TextContent[]): void {
    // Reset auto-segmentation indicators whenever a new PDF is ingested.
    this.textAutoSegmentationService?.reset();

    // Set the status in case workUpcoming was not called.
    this.status.set('loading');

    if (this.segments().length > 0) {
      this.recoverSegmentsForNewTextRecord(content);
      return;
    }

    this.sequentialIdCounter = 0;
    this.addressableSegments.clear();

    let text = '';
    let pdfJsId = '';
    let inMarkedContent = false;
    const segments: TextSegment[] = [];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let segmentFontName = '';
    let segmentFontSize = 10;
    let segmentIsBold = false;
    let segmentIsItalic = false;
    let hasLayout = false;

    content.forEach((pageContent, pageNumberZeroIndexed) => {
      const items = pageContent.items;
      items.forEach((item: TextItem | TextMarkedContent) => {
        // If it is a TextMarkedContent it will have a type that is either 'beginMarkedContentProps' or
        // 'endMarkedContent'.
        if ('type' in item) {
          if (item.type === 'beginMarkedContentProps') {
            inMarkedContent = true;
            pdfJsId = item.id;
            this.sequentialIdCounter++;
            minX = Infinity;
            minY = Infinity;
            maxX = -Infinity;
            maxY = -Infinity;
            segmentFontName = '';
            segmentFontSize = 10;
            segmentIsBold = false;
            segmentIsItalic = false;
            hasLayout = false;
          } else if (item.type === 'endMarkedContent') {
            if (inMarkedContent && pdfJsId && text.trim().length !== 0) {
              const newSegment: TextSegment = {
                // The sequential ID is always one less than the current sequential ID counter, because the counter is
                // incremented when a new marked content is found, but the segment is created when the marked content
                // ends.
                sequentialId: this.sequentialIdCounter - 1,
                pdfJsId: pdfJsId,
                page: pageNumberZeroIndexed + 1,
                text: text,
                excluded: false,
                linkedChildren: [],
                ...(hasLayout
                  ? {
                    bbox: [minX, minY, maxX, maxY],
                    fontName: segmentFontName,
                    fontSize: segmentFontSize,
                    isBold: segmentIsBold,
                    isItalic: segmentIsItalic,
                  }
                  : {}),
              };

              segments.push(newSegment);
              this.addressableSegments.add(pdfJsId);
            }

            text = '';
            inMarkedContent = false;
            minX = Infinity;
            minY = Infinity;
            maxX = -Infinity;
            maxY = -Infinity;
            segmentFontName = '';
            segmentFontSize = 10;
            segmentIsBold = false;
            segmentIsItalic = false;
            hasLayout = false;
          } else if (item.type === 'beginMarkedContent') {
            // We have no way to address marked content without an ID, so they are just ignored, but we still increment
            // the sequential ID counter to keep the sequential IDs consistent with the order of the marked content in
            // the document structure.
            this.sequentialIdCounter++;
          }

          // If it is not a TextMarkedContent it will be a TextItem, which has a 'str' property with the text content.
          // If we are in a marked content, we will add the text to the current segment text.
        } else {
          if ('str' in item && inMarkedContent && item.str.length > 0) {
            // If the first character of the item text is a space excluded character we remove the space that was added
            // at the end of the previous item text.
            if (TextSegmentationService.SPACE_EXCLUDED_CHARACTERS.includes(item.str[0]) && text.length > 0) {
              text = text.slice(0, -1);
            }

            text += item.str + ' ';

            if ('transform' in item && Array.isArray(item.transform) && item.transform.length >= 6) {
              hasLayout = true;
              const tx = item.transform[4];
              const ty = item.transform[5];
              const w = item.width || 0;
              const h = item.height || Math.hypot(item.transform[0], item.transform[1]) || 10;
              const x0 = tx;
              const x1 = tx + w;
              const y0 = -ty - h;
              const y1 = -ty;

              minX = Math.min(minX, x0);
              maxX = Math.max(maxX, x1);
              minY = Math.min(minY, y0);
              maxY = Math.max(maxY, y1);

              if (!segmentFontName && item.fontName) {
                segmentFontName = item.fontName;
                segmentFontSize = Math.hypot(item.transform[0], item.transform[1]) || item.height || 10;
                const styles = (pageContent as { styles?: Record<string, { fontFamily?: string }> }).styles;
                const styleFont = styles?.[item.fontName]?.fontFamily || '';
                segmentIsBold = (/bold/i).test(item.fontName) || (/bold/i).test(styleFont);
                segmentIsItalic = (/italic|oblique/i).test(item.fontName) || (/italic|oblique/i).test(styleFont);
              }
            }
          }
        }
      });
    });

    this.segments.set([...segments]);
    this.status.set('success');
  }

  /**
   * Recovers segments for a new text record. Resets the service state and creates segments from the provided content.
   * 
   * @param content The new text record content.
   */
  private recoverSegmentsForNewTextRecord(content: TextContent[]): void {
    // TODO: Implement segment recovery from previous text records when switching documents.
    this.textAutoSegmentationService?.reset();
    this.sequentialIdCounter = 0;
    this.segments.set([]);
    this.addressableSegments.clear();
    this.segmentText(content);
  }

  /**
   * Toggles the linking of a segment with its relatives. If the segment is a parent segment, it will become a child of
   * the previous parent segment after their last child, the segment's children will become its siblings after it. If
   * the segment is a child segment, it will be promoted to a parent segment under its previous parent segment, and its
   * siblings that were under it before the promotion will become its children.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to toggle linking.
   * @throws Will throw an error if the segment is not found, or if trying to link the first segment.
   */
  public toggleSegmentLinking(pdfJsSegmentId: string): void {
    const currentSegments = this.segments();
    const segmentIndex = currentSegments.findIndex((segment) => segment.pdfJsId === pdfJsSegmentId);
    const segment = currentSegments[segmentIndex];

    // If the segment is a parent segment.
    if (segmentIndex !== -1) {
      if (segmentIndex > 0) {
        // Move the segment and its children to the linkedChildren of the previous segment.
        const previousSegment = currentSegments[segmentIndex - 1];

        previousSegment.linkedChildren.push(segment);
        currentSegments.splice(segmentIndex, 1);

        previousSegment.linkedChildren = [...previousSegment.linkedChildren, ...segment.linkedChildren];
        segment.linkedChildren = [];

        this.segments.set([...currentSegments]);
      } else {
        throw new Error('Cannot link the first segment.');
      }
    
    // If the segment is a child segment.
    } else {
      for (let i = 0; i < currentSegments.length; i++) {
        const childIndex = currentSegments[i].linkedChildren.findIndex((child) => child.pdfJsId === pdfJsSegmentId);
        
        // If the child segment is found, move it to the segments list after the parent segment, with the
        // successor sibling segments as its children.
        if (childIndex !== -1) {
          const childSegment = currentSegments[i].linkedChildren[childIndex];
          const successorSegments = currentSegments[i].linkedChildren.slice(childIndex + 1);
          currentSegments[i].linkedChildren = currentSegments[i].linkedChildren.slice(0, childIndex);
          const newSegmentIndex = i + 1;
          currentSegments.splice(newSegmentIndex, 0, childSegment);
          childSegment.linkedChildren = successorSegments;
          this.segments.set([...currentSegments]);

          return;
        }
      }
      
      throw new Error('Segment not found.');
    }
  }

  /**
   * Exclude a segment from the text segmentation. This method will mark the segment as excluded, and it will be
   * displayed with a strikethrough in the UI. This method deals with segment linking and order. If the segment is a
   * parent segment its first child will be promoted to a parent segment and subsequent siblings will be linked to it.
   * If the segment is a child segment, it will become a parent segment in the next position on the parent segments
   * list.
   * 
   * Note: This method does not remove the segment from the list, it only marks it as excluded. The segment can be
   * included again using the includeSegment method.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to be excluded.
   * @throws Will throw an error if the segment is not found.
   */
  public excludeSegment(pdfJsSegmentId: string): void {
    const segmentIndex = this.findSegmentIndex(pdfJsSegmentId);
    
    if (segmentIndex.parentIndex === -1) {
      throw new Error('Segment not found.');
    }

    const segment = this.segmentFromIndexes(segmentIndex.parentIndex, segmentIndex.childIndex);
        
    // If the segment is a parent segment, promote its first child to a parent segment and link subsequent siblings to
    // it.
    if (segmentIndex.childIndex === -1) {
      if (segment.linkedChildren.length > 0) {
        const currentSegments = this.segments();
        const firstChild = segment.linkedChildren[0];

        // Remove the first child from the parent's linkedChildren.
        segment.linkedChildren.splice(0, 1);

        // Insert the first child as a new parent segment in the next position on the parent segments list.
        currentSegments.splice(segmentIndex.parentIndex + 1, 0, firstChild);

        // Link the remaining children to the new parent segment.
        firstChild.linkedChildren = [...firstChild.linkedChildren, ...segment.linkedChildren];
        segment.linkedChildren = [];
      }
    
    // If the segment is a child segment, promote it to a parent segment in the next position on the parent segments
    // list.
    } else {
      const currentSegments = this.segments();
      const childSegment = segment;
      const parentSegment = currentSegments[segmentIndex.parentIndex];

      // Remove the child segment from the parent's linkedChildren.
      parentSegment.linkedChildren.splice(segmentIndex.childIndex, 1);

      // Insert the child segment as a new parent segment in the next position on the parent segments list.
      currentSegments.splice(segmentIndex.parentIndex + 1, 0, childSegment);
    }

    segment.excluded = true;
    this.segments.set([...this.segments()]);
  }

  /**
   * Include a previously excluded segment back into the text segmentation. This method will mark the segment as
   * included, and it will be displayed normally in the UI.
   *
   * Note: This method does not add a new segment, it only marks an existing excluded segment as included. The segment
   * can be excluded again using the excludeSegment method.
   *
   * @param pdfJsSegmentId The PDF.js ID of the segment to be included.
   * @throws Will throw an error if the segment is not found.
   */
  public includeSegment(pdfJsSegmentId: string): void {
    const segment = this.findSegment(pdfJsSegmentId);
    
    if (!segment) {
      throw new Error('Segment not found.');
    }
    
    segment.excluded = false;
    this.segments.set([...this.segments()]);
  }

  /**
   * Move a segment up in the list of segments. This method will swap the segment with the previous segment in the list.
   * This method does not change the order of the linked children of the segment, so the linked children will maintain
   * their relative order under the segment. For linked children, if the child is the first child of a parent segment,
   * it will be promoted to a parent segment and the previous parent segment and its other children will be linked to
   * it. If the child is not the first child of a parent segment, it will be swapped with the previous child of the same
   * parent segment.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to be moved up.
   * @throws Will throw an error if the segment is not found, or if trying to move the first segment up.
   */
  public moveSegmentUp(pdfJsSegmentId: string): void {
    const segmentIndex = this.findSegmentIndex(pdfJsSegmentId);

    if (segmentIndex.parentIndex === -1) {
      throw new Error('Segment not found.');
    }

    // The segment is a parent segment.
    if (segmentIndex.childIndex === -1) {
      const currentSegments = this.segments();
      const parentIndex = segmentIndex.parentIndex;

      if (parentIndex === 0) {
        throw new Error('Cannot move the first segment up.');
      }

      // Swap the parent segment with the previous parent segment.
      [currentSegments[parentIndex - 1], currentSegments[parentIndex]] =
        [currentSegments[parentIndex], currentSegments[parentIndex - 1]];
      this.segments.set([...currentSegments]);
    
    // The segment is a child segment.
    } else {
      const currentSegments = this.segments();
      const parentSegment = currentSegments[segmentIndex.parentIndex];
      const childIndex = segmentIndex.childIndex;

      // The child segment is the first child of its parent segment, so promote it to a parent segment and give it the
      // previous parent segment and its other children as its linked children.
      if (childIndex === 0) {
        const childSegment = parentSegment.linkedChildren[childIndex];
        
        // Remove the child segment from the parent's linkedChildren.
        parentSegment.linkedChildren.splice(childIndex, 1);

        // Replace the parent segment with the child segment in the parent segments list.
        currentSegments.splice(segmentIndex.parentIndex, 1, childSegment);

        // Link the previous parent segment and its other children to the new parent segment.
        childSegment.linkedChildren = [parentSegment, ...parentSegment.linkedChildren];
        parentSegment.linkedChildren = [];

        this.segments.set([...currentSegments]);
      } else {
        // Swap the child segment with the previous child segment.
        [parentSegment.linkedChildren[childIndex - 1], parentSegment.linkedChildren[childIndex]] =
          [parentSegment.linkedChildren[childIndex], parentSegment.linkedChildren[childIndex - 1]];
        this.segments.set([...currentSegments]);
      }
    }
  }

  /**
   * Move a segment down in the list of segments. For parent segments, this method does not change the order of the
   * linked children of the segment, so the linked children will maintain their relative order under the segment. For
   * child segments, if the child is the last child of a parent segment, it will be promoted to a parent segment and
   * swapped with the next parent segment. If the child is not the last child of a parent segment, it will be swapped
   * with the next child of the same parent segment.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to be moved down.
   * @throws Will throw an error if the segment is not found.
   */
  public moveSegmentDown(pdfJsSegmentId: string): void {
    const segmentIndex = this.findSegmentIndex(pdfJsSegmentId);
    
    if (segmentIndex.parentIndex === -1) {
      throw new Error('Segment not found.');
    }

    // Move the parent segment down.
    if (segmentIndex.childIndex === -1) {
      const currentSegments = this.segments();
      const parentIndex = segmentIndex.parentIndex;
      if (parentIndex < currentSegments.length - 1) {
        [currentSegments[parentIndex], currentSegments[parentIndex + 1]] =
          [currentSegments[parentIndex + 1], currentSegments[parentIndex]];
        this.segments.set([...currentSegments]);
      }
    
    // Move the child segment down.
    } else {
      const currentSegments = this.segments();
      const parentSegment = currentSegments[segmentIndex.parentIndex];
      const childIndex = segmentIndex.childIndex;
      
      // Move the child segment down if it is not the last child of its parent segment.
      if (childIndex < parentSegment.linkedChildren.length - 1) {
        [parentSegment.linkedChildren[childIndex], parentSegment.linkedChildren[childIndex + 1]] =
          [parentSegment.linkedChildren[childIndex + 1], parentSegment.linkedChildren[childIndex]];
        this.segments.set([...currentSegments]);
      } else {
        // If the child segment is the last child of its parent segment, promote it to a parent segment and swap it with
        // the next parent segment.
        if (segmentIndex.parentIndex < currentSegments.length - 1) {
          const childSegment = parentSegment.linkedChildren[childIndex];
          
          // Remove the child segment from the parent's linkedChildren.
          parentSegment.linkedChildren.splice(childIndex, 1);

          // Insert the child segment as a new parent segment in the next position on the parent segments list.
          currentSegments.splice(segmentIndex.parentIndex + 2, 0, childSegment);

          this.segments.set([...currentSegments]);
        }
      }
    }
  }

  /**
   * Checks if a marked content ID is an addressable text segment that can be used with the text segmentation service.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to check.
   * @returns True if the segment is addressable, false otherwise.
   */
  public isMarkedContentAnAddressableSegment(pdfJsSegmentId: string): boolean {
    return this.addressableSegments.has(pdfJsSegmentId);
  }

  /**
   * Returns the next text segment in the flattened list of segments. It will be the next segment to appear if segments
   * are shown in a single flattened list with the child segments after their parent segments.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to find the next segment for.
   * @returns The segment found, or null if the segment is the last segment in the list.
   */
  public nextInFlattenedList(pdfJsSegmentId: string): TextSegment | null {
    const segmentIndex = this.findSegmentIndex(pdfJsSegmentId);
    
    if (segmentIndex.parentIndex === -1) {
      return null;
    }

    const segments = this.segments();
    const parentSegment = segments[segmentIndex.parentIndex];

    // If the segment is a parent segment, return its first child if it has any, otherwise return the next parent
    // segment.
    if (segmentIndex.childIndex === -1) {
      if (parentSegment.linkedChildren.length > 0) {
        return parentSegment.linkedChildren[0];
      } else if (segmentIndex.parentIndex < segments.length - 1) {
        return segments[segmentIndex.parentIndex + 1];
      } else {
        return null;
      }
    
    // If the segment is a child segment, return the next child if it has any, otherwise return the next parent segment.
    } else {
      if (segmentIndex.childIndex < parentSegment.linkedChildren.length - 1) {
        return parentSegment.linkedChildren[segmentIndex.childIndex + 1];
      } else if (segmentIndex.parentIndex < segments.length - 1) {
        return segments[segmentIndex.parentIndex + 1];
      } else {
        return null;
      }
    }
  }

  /**
   * Returns the previous text segment in the flattened list of segments. It will be the previous segment to appear if
   * segments are shown in a single flattened list with the child segments after their parent segments.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to find the previous segment for.
   * @returns The segment found, or null if the segment is the first segment in the list.
   */
  public previousInFlattenedList(pdfJsSegmentId: string): TextSegment | null {
    const segmentIndex = this.findSegmentIndex(pdfJsSegmentId);

    if (segmentIndex.parentIndex === -1) {
      return null;
    }

    const segments = this.segments();
    const parentSegment = segments[segmentIndex.parentIndex];

    // If the segment is a parent segment, return the last child of the previous parent segment if it has any, otherwise
    // return the previous parent segment.
    if (segmentIndex.childIndex === -1) {
      if (segmentIndex.parentIndex > 0) {
        const previousParentSegment = segments[segmentIndex.parentIndex - 1];
        if (previousParentSegment.linkedChildren.length > 0) {
          return previousParentSegment.linkedChildren[previousParentSegment.linkedChildren.length - 1];
        } else {
          return previousParentSegment;
        }
      } else {
        return null;
      }
    
    // If the segment is a child segment, return the previous child if it has any, otherwise return the parent segment.
    } else {
      if (segmentIndex.childIndex > 0) {
        return parentSegment.linkedChildren[segmentIndex.childIndex - 1];
      } else {
        return parentSegment;
      }
    }
  }
  
  /**
   * Finds the parent and child indexes of a segment in the segments list from the PDF.js ID of the segment. Returns -1
   * for the parent and child indexes if the segment is not found. Returns -1 for the child index if the segment is a
   * parent segment.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to find.
   * @returns The parent and child indexes of the segment in the segments list.
   */
  private findSegmentIndex(pdfJsSegmentId: string): { parentIndex: number, childIndex: number } {
    const currentSegments = this.segments();
    const parentIndex = currentSegments.findIndex((segment) => segment.pdfJsId === pdfJsSegmentId);
    
    if (parentIndex !== -1) {
      return { parentIndex, childIndex: -1 };
    }

    for (let i = 0; i < currentSegments.length; i++) {
      const childIndex = currentSegments[i].linkedChildren.findIndex((child) => child.pdfJsId === pdfJsSegmentId);
      if (childIndex !== -1) {
        return { parentIndex: i, childIndex };
      }
    }

    return { parentIndex: -1, childIndex: -1 };
  }

  /**
   * Finds the parent segment in the segments list from the PDF.js ID of any segment (parent or linked child).
   * Returns null if the segment is not found.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment (parent or child) to find the parent segment for.
   * @returns The parent segment found, or null if not found.
   */
  public findParentSegment(pdfJsSegmentId: string): TextSegment | null {
    const segmentIndex = this.findSegmentIndex(pdfJsSegmentId);
    
    if (segmentIndex.parentIndex === -1) {
      return null;
    }
    
    return this.segments()[segmentIndex.parentIndex];
  }

  /**
   * Finds a segment in the segments list from the PDF.js ID of the segment. Returns null if the segment is not found.
   * 
   * @param pdfJsSegmentId The PDF.js ID of the segment to find.
   * @returns The segment found, or null if the segment is not found.
   */
  private findSegment(pdfJsSegmentId: string): TextSegment | null {
    const segmentIndex = this.findSegmentIndex(pdfJsSegmentId);
    
    if (segmentIndex.parentIndex === -1) {
      return null;
    }
    
    return this.segmentFromIndexes(segmentIndex.parentIndex, segmentIndex.childIndex);
  }

  /**
   * Gets a segment from the segments list using its parent and child indexes.
   * 
   * @param parentIndex The index of the parent segment.
   * @param childIndex The index of the child segment, or -1 if the segment is a parent segment.
   * @returns The segment found.
   */
  private segmentFromIndexes(parentIndex: number, childIndex: number): TextSegment {
    const currentSegments = this.segments();
    if (childIndex === -1) {
      return currentSegments[parentIndex];
    } else {
      return currentSegments[parentIndex].linkedChildren[childIndex];
    }
  }

  /**
   * Restores the text segments list to a specific snapshot state, rebuilding addressable segment cache.
   *
   * @param segments The text segments hierarchy to restore.
   */
  public restoreSegments(segments: readonly TextSegment[]): void {
    const cloned = this.cloneSegments(segments);
    this.addressableSegments.clear();

    const registerAddressable = (items: readonly TextSegment[]): void => {
      for (const item of items) {
        if (item.pdfJsId) {
          this.addressableSegments.add(item.pdfJsId);
        }
        if (item.linkedChildren && item.linkedChildren.length > 0) {
          registerAddressable(item.linkedChildren);
        }
      }
    };

    registerAddressable(cloned);
    this.segments.set(cloned);
    this.status.set(cloned.length > 0 ? 'success' : 'idle');
  }

  /**
   * Performs a deep clone of a text segment hierarchy.
   *
   * @param segments The text segments to clone.
   * @returns A deep clone of the text segments.
   */
  public cloneSegments(segments: readonly TextSegment[]): TextSegment[] {
    return segments.map((seg) => ({
      ...seg,
      bbox: seg.bbox ? [...seg.bbox] : undefined,
      linkedChildren: seg.linkedChildren ? this.cloneSegments(seg.linkedChildren) : [],
    }));
  }
}

/**
 * Represents a segment of text extracted from a PDF document.
 */
export interface TextSegment {
  sequentialId: number,
  pdfJsId: string,
  page: number,
  text: string,
  excluded: boolean,
  linkedChildren: TextSegment[],
  bbox?: [number, number, number, number],
  fontName?: string,
  fontSize?: number,
  isBold?: boolean,
  isItalic?: boolean,
}

/**
 * Represents an addressable text segment with PDF.js identifier and page number.
 */
export interface PdfJsAccessibleTextSegment {
  pdfJsId: string,
  page: number,
}

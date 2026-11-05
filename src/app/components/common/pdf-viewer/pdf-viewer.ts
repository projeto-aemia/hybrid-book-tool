import {
  Component,
  computed,
  inject,
  input,
  output,
  model,
  effect,
  viewChild,
  ElementRef,
  Renderer2,
  OnDestroy
} from '@angular/core';

import { DomSanitizer } from '@angular/platform-browser';

import {
  TextSegmentationService,
  type PdfJsAccessibleTextSegment
} from '../../../services/text-segmentation/text-segmentation';

@Component({
  selector: 'app-pdf-viewer',
  templateUrl: './pdf-viewer.html',
  styleUrl: './pdf-viewer.scss'
})
export class PdfViewer implements OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly renderer2 = inject(Renderer2);
  private readonly textSegmentationService = inject(TextSegmentationService);

  public readonly src = input.required<string>();
  public readonly visible = input.required<boolean>();
  public readonly name = input.required<string>();
  public readonly highlightMode = input.required<PdfViewerHighlightMode>();
  public readonly navigateToMarkedContentInViewer = input<PdfJsAccessibleTextSegment | null>(null);
  public readonly navigateToMarkedContentInParent = output<PdfJsAccessibleTextSegment>();
  public readonly selectedMarkedContent = model<PdfJsAccessibleTextSegment | null>(null);
  public readonly hoveredMarkedContent = model<PdfJsAccessibleTextSegment | null>(null);

  private readonly pdfViewerIframe = viewChild.required<ElementRef<HTMLIFrameElement>>('pdfViewerIframe');
  private readonly pagesPendingSetup = new Set<number>();
  private readonly renderedPages = new Set<number>();
  private previousSelectedMarkedContent: PdfJsAccessibleTextSegment | null = null;
  private previousHoveredMarkedContent: PdfJsAccessibleTextSegment | null = null;
  private pendingScrollToMarkedContent: PdfJsAccessibleTextSegment | null = null;
  private readonly unlisteners: (() => void)[] = [];

  protected readonly iframeSrc = computed(() => {
    const src = this.src();
    const safeSrc = this.isValidViewerSrc(src) ? src : '';
    const iframeUrl = new URL('pdf-viewer', document.baseURI);
    iframeUrl.searchParams.set('pdf-viewer-src', safeSrc);
    iframeUrl.searchParams.set('pdf-viewer-name', this.name());
    return this.sanitizer.bypassSecurityTrustResourceUrl(iframeUrl.toString());
  });

  /**
   * Validates that the provided PDF source URL uses a safe scheme.
   *
   * @param src The source URL string.
   * @returns Whether the URL scheme is considered safe.
   */
  private isValidViewerSrc(src: string): boolean {
    if (!src) {
      return true;
    }

    const trimmed = src.trim().toLowerCase();
    if (
      trimmed.startsWith('javascript:') ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('vbscript:')
    ) {
      return false;
    }

    return true;
  }

  constructor() {
    effect(() => {
      if (this.textSegmentationService.status() === 'success') {
        this.pagesPendingSetup.forEach((pageNumber) => {
          this.setupHighlightSpansOnPage(pageNumber);
          this.styleCursorOnPage(pageNumber);
        });
        this.pagesPendingSetup.clear();
      }
    });

    effect(() => {
      // In 'text-segment' mode, highlight spans must update when segment linking changes in TextSegmentationService.
      this.textSegmentationService.segments();
      if (this.highlightMode() === 'text-segment' && this.textSegmentationService.status() === 'success') {
        this.renderedPages.forEach((pageNumber) => {
          this.setupHighlightSpansForTextSegmentsOnPage(pageNumber);
        });

        // Re-apply active highlights if they were affected.
        const selected = this.selectedMarkedContent();
        if (selected) {
          this.updateSelectionHighlight(selected, true);
        }
        const hovered = this.hoveredMarkedContent();
        if (hovered) {
          this.updateHoverHighlight(hovered, true);
        }
      }
    });

    effect(() => {
      const selected = this.selectedMarkedContent();
      this.updateSelectionHighlight(selected);
    });

    effect(() => {
      const hovered = this.hoveredMarkedContent();
      
      // Track selectedMarkedContent as well so that hover highlight updates when selection changes.
      this.selectedMarkedContent();

      this.updateHoverHighlight(hovered);
    });

    effect(() => {
      const markedContent = this.navigateToMarkedContentInViewer();
      
      if (markedContent) {
        this.navigateToMarkedContent(markedContent);
      }
    });

    this.unlisteners.push(this.renderer2.listen('window', 'message', (event: MessageEvent) => {
      if (
        event.data?.name === this.name() &&
        event.origin === document.location.origin &&
        event.source === this.pdfViewerIframe().nativeElement.contentWindow
      ) {
        if (event.data?.type === 'pdf-viewer-text-layer-rendered') {
          const pageNumber = parseInt(event.data.pageNumber, 10);
          this.renderedPages.add(pageNumber);
          this.addSegmentInteractionEventListenersToPage(pageNumber);
          
          // We can't determine whether an element is addressable until the text segmentation service has finished
          // segmenting the text. So we need to wait for the service to finish the segmentation before setting up
          // keyboard focus/highlights and styling the cursor on the page. So we add the page number to the list of
          // pages pending setup; when the service finishes the segmentation, we setup and style all pending pages.
          if (this.textSegmentationService.status() === 'success') {
            this.setupHighlightSpansOnPage(pageNumber);
            this.styleCursorOnPage(pageNumber);
          } else {
            this.pagesPendingSetup.add(pageNumber);
          }

          // Apply active highlights for this page if they are now ready.
          const selected = this.selectedMarkedContent();
          if (selected && selected.page === pageNumber) {
            this.updateSelectionHighlight(selected);
          }
          const hovered = this.hoveredMarkedContent();
          if (hovered && hovered.page === pageNumber) {
            this.updateHoverHighlight(hovered);
          }

          if (this.pendingScrollToMarkedContent && this.pendingScrollToMarkedContent.page === pageNumber) {
            // Apply the selection highlight to the selected marked content. It was not possible to apply the selection
            // highlight before because the page was not yet rendered, so we apply it now. We apply the selection
            // highlight to the currently selected segment rather than the pending scroll-to segment because the
            // selection may have been changed while the page was being rendered, possibly to a segment in the same page
            // as the scroll-to segment.
            this.updateSelectionHighlight(this.selectedMarkedContent(), true);
            
            this.scrollToMarkedContent(this.pendingScrollToMarkedContent);
            this.pendingScrollToMarkedContent = null;
          }
        } else if (event.data?.type === 'pdf-viewer-pages-loaded') {
          this.addViewerStyles();
        }
      }
    }));
  }

  /*
   * DANGER: This area bypasses Angular templates to interact directly with the DOM. This is required because we
   * must interact with the PDF.js viewer, which is not part of the Angular application. This is a fragile area of
   * the code and should be treated with caution. Any changes to the PDF.js viewer or its DOM structure may break
   * this code.
   */
  
  /**
   * Highlights a marked content in the PDF viewer by adding an outline to it. If there was a previously highlighted
   * marked content, it removes the outline from it.
   * 
   * @param markedContent The marked content to highlight.
   * @param type The type of highlight: 'select' for selected marked content, 'hover' for hovered marked content.
   */
  private highlightMarkedContent(markedContent: PdfJsAccessibleTextSegment, type: 'select' | 'hover') {
    const iframeDocument: Document | null = this.pdfViewerIframe().nativeElement.contentDocument;
    
    if (iframeDocument === null) {
      throw new Error('PDF viewer iframe document is not available.');
    }
    
    const page: HTMLDivElement | null = iframeDocument.querySelector(`.page[data-page-number="${markedContent.page}"]`);
    const previous: PdfJsAccessibleTextSegment | null = type === 'select'
      ? this.previousSelectedMarkedContent
      : this.previousHoveredMarkedContent;

    if (page === null) {
      throw new Error(`Page ${markedContent.page} is not available in the PDF viewer.`);
    }

    if (previous) {
      if (previous.pdfJsId === markedContent.pdfJsId && previous.page === markedContent.page) {
        return;
      }
      this.removeMarkedContentHighlight(previous);
    }

    const markedContentElement: HTMLElement | null = iframeDocument.getElementById(markedContent.pdfJsId);
    const highlightSpan = markedContentElement?.querySelector('.marked-content-highlight') as HTMLSpanElement | null;
    if (highlightSpan) {
      highlightSpan.style.outline = `0.25rem solid ${type === 'select'
        ? 'var(--primary-color)'
        : 'var(--primary-accent)'}`;
      highlightSpan.style.zIndex = type === 'select' ? '1' : '2';
    }

    if (type === 'select') {
      this.previousSelectedMarkedContent = markedContent;
    } else {
      this.previousHoveredMarkedContent = markedContent;
    }
  }

  /**
   * Removes the highlight from a marked content.
   * 
   * @param markedContent The marked content to remove the highlight from.
   */
  private removeMarkedContentHighlight(markedContent: PdfJsAccessibleTextSegment) {
    const iframeDocument: Document | null = this.pdfViewerIframe().nativeElement.contentDocument;
    
    if (iframeDocument === null) {
      throw new Error('PDF viewer iframe document is not available.');
    }
    
    const highlightSpan = iframeDocument.getElementById(markedContent.pdfJsId)
      ?.querySelector('.marked-content-highlight') as HTMLSpanElement | null;
    if (highlightSpan) {
      highlightSpan.style.outline = 'none';
      highlightSpan.style.zIndex = '0';
    }
  }

  /**
   * Updates the selection highlight on the PDF viewer.
   * 
   * @param selected The selected marked content, or null to remove selection highlight.
   * @param forceUpdate Whether to force an update even if the selected content is the same.
   */
  private updateSelectionHighlight(selected: PdfJsAccessibleTextSegment | null, forceUpdate = false) {
    const iframeDocument = this.pdfViewerIframe().nativeElement.contentDocument;
    if (!iframeDocument) {
      return;
    }

    if (this.previousSelectedMarkedContent) {
      if (
        forceUpdate ||
        !selected ||
        (
          this.previousSelectedMarkedContent.pdfJsId !== selected.pdfJsId ||
          this.previousSelectedMarkedContent.page !== selected.page
        )
      ) {
        try {
          this.removeMarkedContentHighlight(this.previousSelectedMarkedContent);
        } catch (_e) {
          // Ignore if page/element is not found.
        }
        this.previousSelectedMarkedContent = null;
      }
    }

    if (selected) {
      const page = iframeDocument.querySelector(`.page[data-page-number="${selected.page}"]`);
      if (page) {
        // If the hovered element is the same as the selected element, remove the hover highlight first.
        if (
          this.previousHoveredMarkedContent &&
          this.previousHoveredMarkedContent.pdfJsId === selected.pdfJsId &&
          this.previousHoveredMarkedContent.page === selected.page) {
          try {
            this.removeMarkedContentHighlight(this.previousHoveredMarkedContent);
          } catch (_e) {
            // Ignore.
          }
          this.previousHoveredMarkedContent = null;
        }

        try {
          this.highlightMarkedContent(selected, 'select');
        } catch (_e) {
          // Ignore.
        }
      }
    }
  }

  /**
   * Updates the hover highlight on the PDF viewer.
   * 
   * @param hovered The hovered marked content, or null to remove hover highlight.
   * @param forceUpdate Whether to force an update even if the hovered content is the same.
   */
  private updateHoverHighlight(hovered: PdfJsAccessibleTextSegment | null, forceUpdate = false) {
    const iframeDocument = this.pdfViewerIframe().nativeElement.contentDocument;
    if (!iframeDocument) {
      return;
    }

    const selected = this.selectedMarkedContent();

    if (this.previousHoveredMarkedContent) {
      const isSelected = selected &&
        selected.pdfJsId === this.previousHoveredMarkedContent.pdfJsId &&
        selected.page === this.previousHoveredMarkedContent.page;

      const isDifferent = !hovered ||
        this.previousHoveredMarkedContent.pdfJsId !== hovered.pdfJsId ||
        this.previousHoveredMarkedContent.page !== hovered.page;

      if (forceUpdate || isSelected || isDifferent) {
        try {
          this.removeMarkedContentHighlight(this.previousHoveredMarkedContent);
        } catch (_e) {
          // Ignore.
        }
        this.previousHoveredMarkedContent = null;
      }
    }

    if (hovered) {
      const isSelected = selected &&
        selected.pdfJsId === hovered.pdfJsId &&
        selected.page === hovered.page;

      if (!isSelected) {
        const page = iframeDocument.querySelector(`.page[data-page-number="${hovered.page}"]`);
        if (page) {
          try {
            this.highlightMarkedContent(hovered, 'hover');
          } catch (_e) {
            // Ignore.
          }
        }
      }
    }
  }

  /**
   * Navigates to a marked content element in the PDF viewer, scrolling to it if the text layer is already rendered
   * or messaging the iframe to jump to its page if not.
   * 
   * @param markedContent The marked content segment to navigate to.
   */
  private navigateToMarkedContent(markedContent: PdfJsAccessibleTextSegment) {
    const iframeDocument = this.pdfViewerIframe().nativeElement.contentDocument;

    if (!iframeDocument) {
      return;
    }

    const page = iframeDocument.querySelector(`.page[data-page-number="${markedContent.page}"]`);

    let pageHasTextLayer = false;
    if (page) {
      const textLayer = page.querySelector('.textLayer');
      if (textLayer) {
        pageHasTextLayer = true;
      }
    }

    if (page && pageHasTextLayer) {
      this.scrollToMarkedContent(markedContent);
    } else {
      const iframeWindow = this.pdfViewerIframe().nativeElement.contentWindow;
  
      if (iframeWindow) {
        iframeWindow.postMessage({
          name: this.name(),
          type: 'pdf-viewer-jump-to-page',
          pageNumber: markedContent.page,
          pageHasTextLayer
        }, document.location.origin);
      }
    }

    this.pendingScrollToMarkedContent = markedContent;
  }

  /**
   * Scrolls the PDF viewer iframe so that the specified marked content highlight is visible in the center of the
   * view.
   * 
   * @param markedContent The marked content segment to scroll to.
   */
  private scrollToMarkedContent(markedContent: PdfJsAccessibleTextSegment) {
    const iframeDocument = this.pdfViewerIframe().nativeElement.contentDocument;

    if (!iframeDocument) {
      return;
    }
    
    const markedContentElement = iframeDocument.getElementById(markedContent.pdfJsId);
    const markedContentHighlight = markedContentElement
      ?.querySelector('.marked-content-highlight') as HTMLElement | null;

    if (markedContentHighlight) {
      markedContentHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /**
   * Adds event listeners to a page in the PDF viewer.
   * 
   * @param pageNumber The number of the page to add event listeners to.
   */
  private addSegmentInteractionEventListenersToPage(pageNumber: number) {
    const iframeDocument: Document | null = this.pdfViewerIframe().nativeElement.contentDocument;
    
    if (iframeDocument === null) {
      throw new Error('PDF viewer iframe document is not available.');
    }
    
    const pageElement: HTMLDivElement | null = iframeDocument.querySelector(`.page[data-page-number="${pageNumber}"]`);

    if (pageElement === null) {
      throw new Error(`Page ${pageNumber} is not available in the PDF viewer.`);
    }
    
    this.unlisteners.push(this.renderer2.listen(pageElement, 'click', (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      
      if (target === null) {
        return;
      }
      
      const markedContentElement = target.closest('.markedContent') as HTMLElement | null;

      if (markedContentElement === null) {
        return;
      }

      if (!this.isMarkedContentElementAddressable(markedContentElement)) {
        return;
      }

      const markedContentId = markedContentElement.id;
      const page = parseInt(pageElement?.getAttribute('data-page-number') || '0', 10);

      if (this.highlightMode() === 'text-segment') {
        const parentSegment = this.textSegmentationService.findParentSegment(markedContentId);
        if (parentSegment) {
          this.selectedMarkedContent.set({ pdfJsId: parentSegment.pdfJsId, page: parentSegment.page });
          const parentElement = iframeDocument.getElementById(parentSegment.pdfJsId);
          (parentElement?.querySelector('.marked-content-highlight') as HTMLElement | null)?.focus();
        }
      } else {
        this.selectedMarkedContent.set({ pdfJsId: markedContentId, page });
        (markedContentElement.querySelector('.marked-content-highlight') as HTMLElement | null)?.focus();
      }
    }));

    this.unlisteners.push(this.renderer2.listen(pageElement, 'dblclick', (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      
      if (target === null) {
        return;
      }
      
      const markedContentElement = target.closest('.markedContent') as HTMLElement | null;

      if (markedContentElement === null) {
        return;
      }

      if (!this.isMarkedContentElementAddressable(markedContentElement)) {
        return;
      }

      const markedContentId = markedContentElement.id;
      const page = parseInt(pageElement?.getAttribute('data-page-number') || '0', 10);

      if (this.highlightMode() === 'text-segment') {
        const parentSegment = this.textSegmentationService.findParentSegment(markedContentId);
        if (parentSegment) {
          this.navigateToMarkedContentInParent.emit({ pdfJsId: parentSegment.pdfJsId, page: parentSegment.page });
        }
      } else {
        this.navigateToMarkedContentInParent.emit({ pdfJsId: markedContentId, page });
      }
    }));

    this.unlisteners.push(this.renderer2.listen(pageElement, 'mouseover', (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      
      if (target === null) {
        return;
      }
      
      const markedContentElement = target.closest('.markedContent') as HTMLElement | null;

      if (markedContentElement === null) {
        return;
      }

      if (!this.isMarkedContentElementAddressable(markedContentElement)) {
        return;
      }

      const markedContentId = markedContentElement.id;
      const page = parseInt(pageElement?.getAttribute('data-page-number') || '0', 10);

      if (this.highlightMode() === 'text-segment') {
        const parentSegment = this.textSegmentationService.findParentSegment(markedContentId);
        if (parentSegment) {
          const currentHovered = this.hoveredMarkedContent();
          if (
            !currentHovered ||
            currentHovered.pdfJsId !== parentSegment.pdfJsId ||
            currentHovered.page !== parentSegment.page
          ) {
            this.hoveredMarkedContent.set({ pdfJsId: parentSegment.pdfJsId, page: parentSegment.page });
          }
        }
      } else {
        const currentHovered = this.hoveredMarkedContent();
        if (!currentHovered || currentHovered.pdfJsId !== markedContentId || currentHovered.page !== page) {
          this.hoveredMarkedContent.set({ pdfJsId: markedContentId, page });
        }
      }
    }));

    this.unlisteners.push(this.renderer2.listen(pageElement, 'mouseout', (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      
      if (target === null) {
        return;
      }
      
      const markedContentElement = target.closest('.markedContent') as HTMLElement | null;

      if (markedContentElement === null) {
        return;
      }

      if (!this.isMarkedContentElementAddressable(markedContentElement)) {
        return;
      }

      this.hoveredMarkedContent.set(null);
    }));
  }

  /**
   * Sets up highlight spans on a page according to the highlightMode.
   * 
   * @param pageNumber The number of the page to set up highlight spans on.
   */
  private setupHighlightSpansOnPage(pageNumber: number) {
    if (this.highlightMode() === 'text-segment') {
      this.setupHighlightSpansForTextSegmentsOnPage(pageNumber);
    } else {
      this.setupHighlightSpansAndKeyboardNavigationOnPage(pageNumber);
    }
  }

  /**
   * Sets up highlight spans for individual marked contents in 'marked-content' mode.
   * 
   * @param pageNumber The number of the page to set up highlight spans on.
   */
  private setupHighlightSpansAndKeyboardNavigationOnPage(pageNumber: number) {
    const iframeDocument: Document | null = this.pdfViewerIframe().nativeElement.contentDocument;
    
    if (iframeDocument === null) {
      throw new Error('PDF viewer iframe document is not available.');
    }
    
    const pageElement: HTMLDivElement | null = iframeDocument.querySelector(`.page[data-page-number="${pageNumber}"]`);

    if (pageElement === null) {
      throw new Error(`Page ${pageNumber} is not available in the PDF viewer.`);
    }

    // Set the tabindex of all elements that can be tabbed to -1 so that they are not keyboard focusable.
    const keyboardFocusableElements = pageElement.querySelectorAll<HTMLElement>(
      'a, area, button, input, textarea, select, details, [tabindex]:not([tabindex="-1"])'
    );
    keyboardFocusableElements.forEach((element) => {
      element.setAttribute('tabindex', '-1');
    });

    const markedContentElements = pageElement.querySelectorAll<HTMLElement>('.markedContent');
    const pageClientRect = pageElement.getBoundingClientRect();

    markedContentElements.forEach((element) => {
      if (!this.isMarkedContentElementAddressable(element)) {
        return;
      }

      // Check if highlight span already exists to avoid duplicates.
      if (element.querySelector('.marked-content-highlight')) {
        return;
      }

      let minLeft = Number.MAX_VALUE;
      let minTop = Number.MAX_VALUE;
      let maxRight = Number.MIN_VALUE;
      let maxBottom = Number.MIN_VALUE;

      for (const child of element.children) {
        const childClientRect = (child as HTMLElement).getBoundingClientRect();

        // Disregard elements with no width or height.
        if (childClientRect.width === 0 || childClientRect.height === 0) {
          continue;
        }

        if (child.classList.contains('marked-content-highlight')) {
          continue;
        }
        
        const childLeft = parseFloat((child as HTMLElement).style.left || '0%');
        const childTop = parseFloat((child as HTMLElement).style.top || '0%');

        if (childLeft < minLeft) {
          minLeft = childLeft;
        }

        if (childTop < minTop) {
          minTop = childTop;
        }
        
        const childWidthProportion = childClientRect.width / pageClientRect.width;
        const childHeightProportion = childClientRect.height / pageClientRect.height;

        const childRight = childLeft + (childWidthProportion * 100);
        const childBottom = childTop + (childHeightProportion * 100);

        if (childRight > maxRight) {
          maxRight = childRight;
        }

        if (childBottom > maxBottom) {
          maxBottom = childBottom;
        }
      }

      // If no valid children were measured, skip creating the highlight span.
      if (minLeft === Number.MAX_VALUE) {
        return;
      }

      const highlightSpan: HTMLSpanElement = iframeDocument.createElement('span');

      highlightSpan.classList.add('marked-content-highlight');
      highlightSpan.setAttribute('role', 'presentation');
      highlightSpan.setAttribute('tabindex', '0');
      highlightSpan.style.position = 'absolute';
      highlightSpan.style.top = `calc(${minTop}% - 0.5rem)`;
      highlightSpan.style.left = `calc(${minLeft}% - 0.5rem)`;
      highlightSpan.style.width = `calc(${maxRight - minLeft}% + 1rem)`;
      highlightSpan.style.height = `calc(${maxBottom - minTop}% + 1rem)`;
      highlightSpan.style.outlineOffset = '-0.25rem';
      highlightSpan.style.outline = 'none';
      highlightSpan.style.cursor = 'pointer';
      highlightSpan.style.zIndex = '0';
      highlightSpan.style.backgroundColor = 'transparent';

      this.unlisteners.push(this.renderer2.listen(highlightSpan, 'focus', () => {
        const markedContentId = element.id;
        this.hoveredMarkedContent.set({ pdfJsId: markedContentId, page: pageNumber });
      }));

      this.unlisteners.push(this.renderer2.listen(highlightSpan, 'blur', () => {
        this.hoveredMarkedContent.set(null);
      }));

      this.unlisteners.push(this.renderer2.listen(highlightSpan, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const markedContentId = element.id;
          this.selectedMarkedContent.set({ pdfJsId: markedContentId, page: pageNumber });
        }
      }));

      element.appendChild(highlightSpan);
    });
  }

  /**
   * Sets up highlight spans for text segments (parent + linked children) in 'text-segment' mode.
   * 
   * @param pageNumber The number of the page to set up highlight spans on.
   */
  private setupHighlightSpansForTextSegmentsOnPage(pageNumber: number) {
    const iframeDocument: Document | null = this.pdfViewerIframe().nativeElement.contentDocument;
    
    if (iframeDocument === null) {
      throw new Error('PDF viewer iframe document is not available.');
    }
    
    const pageElement: HTMLDivElement | null = iframeDocument.querySelector(`.page[data-page-number="${pageNumber}"]`);

    if (pageElement === null) {
      throw new Error(`Page ${pageNumber} is not available in the PDF viewer.`);
    }

    // Set the tabindex of all elements that can be tabbed to -1 so that they are not keyboard focusable.
    const keyboardFocusableElements = pageElement.querySelectorAll<HTMLElement>(
      'a, area, button, input, textarea, select, details, [tabindex]:not([tabindex="-1"])'
    );
    keyboardFocusableElements.forEach((element) => {
      element.setAttribute('tabindex', '-1');
    });

    const segments = this.textSegmentationService.segments();
    const parentSegmentsOnPage = segments.filter((s) => s.page === pageNumber);
    const parentSegmentIdsOnPage = new Set(parentSegmentsOnPage.map((s) => s.pdfJsId));

    // Remove any highlight spans from elements on this page that are not parent segments on this page.
    const existingHighlightSpans = pageElement.querySelectorAll<HTMLSpanElement>('.marked-content-highlight');
    existingHighlightSpans.forEach((span) => {
      const parentId = (span.parentElement as HTMLElement)?.id;
      if (!parentId || !parentSegmentIdsOnPage.has(parentId)) {
        span.remove();
      }
    });

    const pageClientRect = pageElement.getBoundingClientRect();

    parentSegmentsOnPage.forEach((parentSegment) => {
      const parentElement = iframeDocument.getElementById(parentSegment.pdfJsId);
      if (!parentElement || !this.isMarkedContentElementAddressable(parentElement)) {
        return;
      }

      // Collect all marked content elements belonging to this segment that are on this page
      const elementsToMeasure: HTMLElement[] = [parentElement];
      for (const child of parentSegment.linkedChildren) {
        const childElement = iframeDocument.getElementById(child.pdfJsId);
        if (childElement && childElement.closest('.page') === pageElement) {
          elementsToMeasure.push(childElement);
          
          // Remove any highlight span on child element if present.
          const childSpan = childElement.querySelector('.marked-content-highlight');
          if (childSpan) {
            childSpan.remove();
          }
        }
      }

      let minLeft = Number.MAX_VALUE;
      let minTop = Number.MAX_VALUE;
      let maxRight = Number.MIN_VALUE;
      let maxBottom = Number.MIN_VALUE;

      for (const el of elementsToMeasure) {
        for (const child of el.children) {
          const childClientRect = (child as HTMLElement).getBoundingClientRect();

          // Disregard elements with no width or height.
          if (childClientRect.width === 0 || childClientRect.height === 0) {
            continue;
          }

          if (child.classList.contains('marked-content-highlight')) {
            continue;
          }
          
          const childLeft = parseFloat((child as HTMLElement).style.left || '0%');
          const childTop = parseFloat((child as HTMLElement).style.top || '0%');

          if (childLeft < minLeft) {
            minLeft = childLeft;
          }

          if (childTop < minTop) {
            minTop = childTop;
          }
          
          const childWidthProportion = childClientRect.width / pageClientRect.width;
          const childHeightProportion = childClientRect.height / pageClientRect.height;

          const childRight = childLeft + (childWidthProportion * 100);
          const childBottom = childTop + (childHeightProportion * 100);

          if (childRight > maxRight) {
            maxRight = childRight;
          }

          if (childBottom > maxBottom) {
            maxBottom = childBottom;
          }
        }
      }

      // If no valid children were measured, skip creating the highlight span.
      if (minLeft === Number.MAX_VALUE) {
        return;
      }

      let highlightSpan = parentElement.querySelector(':scope > .marked-content-highlight') as HTMLSpanElement | null;
      if (!highlightSpan) {
        highlightSpan = iframeDocument.createElement('span');

        highlightSpan.classList.add('marked-content-highlight');
        highlightSpan.setAttribute('role', 'presentation');
        highlightSpan.setAttribute('tabindex', '0');
        highlightSpan.style.position = 'absolute';
        highlightSpan.style.outlineOffset = '-0.25rem';
        highlightSpan.style.outline = 'none';
        highlightSpan.style.cursor = 'pointer';
        highlightSpan.style.zIndex = '0';
        highlightSpan.style.backgroundColor = 'transparent';

        this.unlisteners.push(this.renderer2.listen(highlightSpan, 'focus', () => {
          this.hoveredMarkedContent.set({ pdfJsId: parentSegment.pdfJsId, page: pageNumber });
        }));

        this.unlisteners.push(this.renderer2.listen(highlightSpan, 'blur', () => {
          this.hoveredMarkedContent.set(null);
        }));

        this.unlisteners.push(this.renderer2.listen(highlightSpan, 'keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.selectedMarkedContent.set({ pdfJsId: parentSegment.pdfJsId, page: pageNumber });
          }
        }));

        parentElement.appendChild(highlightSpan);
      }

      highlightSpan.style.top = `calc(${minTop}% - 0.5rem)`;
      highlightSpan.style.left = `calc(${minLeft}% - 0.5rem)`;
      highlightSpan.style.width = `calc(${maxRight - minLeft}% + 1rem)`;
      highlightSpan.style.height = `calc(${maxBottom - minTop}% + 1rem)`;
    });
  }

  /**
   * Adds custom styles to the PDF viewer iframe.
   * 
   * The only style applied is `user-select: none` to the `.page` class, which prevents text selection on the pages.
   * This is done to prevent accidental selection of text when interacting with the marked content elements. It
   * shouldn't be possible to select text in general due to the the hover highlight, but selecting text causes many
   * issues with the selection when it is done, so it is better to disable it completely in case it can be done in some
   * case for some reason.
   */
  private addViewerStyles() {
    const iframeDocument: Document | null = this.pdfViewerIframe().nativeElement.contentDocument;
    
    if (iframeDocument === null) {
      throw new Error('PDF viewer iframe document is not available.');
    }

    const styleElement: HTMLStyleElement = iframeDocument.createElement('style');
    styleElement.textContent = `
      .page .textLayer * {
        user-select: none;
      }
      
      .annotationLayer {
        display: none !important;
      }
    `;
    iframeDocument.head.appendChild(styleElement);
  }
  
  /**
   * Adds the pointer cursor style to all marked content elements on a page that can be clicked.
   * 
   * @param pageNumber The number of the page on which to style the cursors.
   */
  private styleCursorOnPage(pageNumber: number) {
    const iframeDocument: Document | null = this.pdfViewerIframe().nativeElement.contentDocument;
    
    if (iframeDocument === null) {
      throw new Error('PDF viewer iframe document is not available.');
    }
    
    const pageElement: HTMLDivElement | null = iframeDocument.querySelector(`.page[data-page-number="${pageNumber}"]`);

    if (pageElement === null) {
      throw new Error(`Page ${pageNumber} is not available in the PDF viewer.`);
    }

    pageElement.querySelectorAll('.markedContent').forEach((markedContentElement) => {
      if (!this.isMarkedContentElementAddressable(markedContentElement)) {
        return;
      }

      for (const child of markedContentElement.children) {
        (child as HTMLElement).style.cursor = 'pointer';
      }
    });
  }
  
  /**
   * Checks if an element is addressable and can be used with the text segmentation service.
   * 
   * @param markedContentElement The marked content element.
   * @returns True if the element is addressable and works with the text segmentation, and false otherwise.
   */
  private isMarkedContentElementAddressable(markedContentElement: Element): boolean {
    if (!markedContentElement.hasAttribute('id')) {
      return false;
    }

    if (!this.textSegmentationService.isMarkedContentAnAddressableSegment(markedContentElement.id)) {
      return false;
    }

    return true;
  }
  
  /*
   * END OF DANGER AREA.
   */

  ngOnDestroy() {
    this.unlisteners.forEach((unlisten) => unlisten());
  }
}

export type PdfViewerHighlightMode = 'marked-content' | 'text-segment';

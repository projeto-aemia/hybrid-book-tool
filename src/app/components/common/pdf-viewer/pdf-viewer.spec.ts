import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PdfViewer } from './pdf-viewer';
import {
  TextSegmentationService,
  type TextSegment,
  type PdfJsAccessibleTextSegment
} from '../../../services/text-segmentation/text-segmentation';

describe('PdfViewer', () => {
  let component: PdfViewer;
  let fixture: ComponentFixture<PdfViewer>;
  let textSegmentationService: TextSegmentationService;
  let iframeDoc: Document;
  let pageElement: HTMLDivElement;
  let iframeWindow: Window;

  const createMockSegment = (id: string, page: number, linkedChildren: TextSegment[] = []): TextSegment => ({
    sequentialId: parseInt(id.replace(/\D/g, '') || '0', 10),
    pdfJsId: id,
    page,
    text: `Text for ${id}`,
    excluded: false,
    linkedChildren,
  });

  const setupIframeDom = () => {
    const iframe = fixture.nativeElement.querySelector('iframe') as HTMLIFrameElement;
    iframeDoc = document.implementation.createHTMLDocument('pdf-viewer');
    iframeWindow = {
      postMessage: () => undefined,
    } as unknown as Window;

    Object.defineProperty(iframe, 'contentDocument', {
      value: iframeDoc,
      configurable: true,
    });
    Object.defineProperty(iframe, 'contentWindow', {
      value: iframeWindow,
      configurable: true,
    });

    iframeDoc.body.innerHTML = '';
    pageElement = iframeDoc.createElement('div');
    pageElement.className = 'page';
    pageElement.setAttribute('data-page-number', '1');
    mockBoundingClientRect(pageElement, { width: 1000, height: 1000, left: 0, top: 0, right: 1000, bottom: 1000 });
    iframeDoc.body.appendChild(pageElement);
  };

  const addMarkedContentToPage = (
    id: string,
    leftPercent: number,
    topPercent: number,
    widthPx: number,
    heightPx: number
  ) => {
    const mc = iframeDoc.createElement('div');
    mc.className = 'markedContent';
    mc.id = id;

    const span = iframeDoc.createElement('span');
    span.style.left = `${leftPercent}%`;
    span.style.top = `${topPercent}%`;
    span.textContent = `Text ${id}`;
    mockBoundingClientRect(span, {
      width: widthPx,
      height: heightPx,
      left: leftPercent * 10,
      top: topPercent * 10,
      right: leftPercent * 10 + widthPx,
      bottom: topPercent * 10 + heightPx
    });

    mc.appendChild(span);
    pageElement.appendChild(mc);
    return mc;
  };

  const mockBoundingClientRect = (
    element: HTMLElement,
    rect: { width: number, height: number, left: number, top: number, right: number, bottom: number }
  ) => {
    element.getBoundingClientRect = () => ({
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    });
  };

  const simulateTextLayerRendered = (pageNumber = 1) => {
    const iframe = fixture.nativeElement.querySelector('iframe') as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        name: 'test-viewer',
        type: 'pdf-viewer-text-layer-rendered',
        pageNumber: pageNumber.toString(),
      },
      origin: document.location.origin,
      source: iframe.contentWindow,
    }));
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PdfViewer],
    }).compileComponents();

    textSegmentationService = TestBed.inject(TextSegmentationService);
  });

  describe('marked-content mode', () => {
    beforeEach(async () => {
      fixture = TestBed.createComponent(PdfViewer);
      fixture.componentRef.setInput('src', 'blob:test-pdf');
      fixture.componentRef.setInput('visible', true);
      fixture.componentRef.setInput('name', 'test-viewer');
      fixture.componentRef.setInput('highlightMode', 'marked-content');
      component = fixture.componentInstance;
      fixture.detectChanges();
      await fixture.whenStable();

      setupIframeDom();
    });

    it('should create in marked-content mode', () => {
      expect(component).toBeTruthy();
      expect(component.highlightMode()).toBe('marked-content');
    });

    it('should sanitize unsafe src schemes to empty in iframe URL', () => {
      fixture.componentRef.setInput('src', 'javascript:alert(1)');
      fixture.detectChanges();
      const iframe = fixture.nativeElement.querySelector('iframe') as HTMLIFrameElement;
      expect(iframe.src).not.toContain('javascript');
      expect(iframe.src).toContain('pdf-viewer-src=&');
    });

    it('should create individual highlight spans for each addressable marked content element', async () => {
      const seg1 = createMockSegment('mc-1', 1);
      const seg2 = createMockSegment('mc-2', 1);
      textSegmentationService.segments.set([seg1, seg2]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService['addressableSegments'].add('mc-2');
      textSegmentationService.status.set('success');

      const mc1 = addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      const mc2 = addMarkedContentToPage('mc-2', 10, 40, 100, 20);

      simulateTextLayerRendered(1);
      await fixture.whenStable();

      const span1 = mc1.querySelector('.marked-content-highlight') as HTMLSpanElement;
      const span2 = mc2.querySelector('.marked-content-highlight') as HTMLSpanElement;

      expect(span1).toBeTruthy();
      expect(span2).toBeTruthy();
      expect(span1.parentElement).toBe(mc1);
      expect(span2.parentElement).toBe(mc2);
    });

    it('should set selectedMarkedContent to the clicked marked content on click', async () => {
      const seg1 = createMockSegment('mc-1', 1);
      textSegmentationService.segments.set([seg1]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService.status.set('success');

      const mc1 = addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      simulateTextLayerRendered(1);
      await fixture.whenStable();

      mc1.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(component.selectedMarkedContent()).toEqual({ pdfJsId: 'mc-1', page: 1 });
    });

    it('should set hoveredMarkedContent on mouseover and clear on mouseout', async () => {
      const seg1 = createMockSegment('mc-1', 1);
      textSegmentationService.segments.set([seg1]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService.status.set('success');

      const mc1 = addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      simulateTextLayerRendered(1);
      await fixture.whenStable();

      mc1.querySelector('span')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(component.hoveredMarkedContent()).toEqual({ pdfJsId: 'mc-1', page: 1 });

      mc1.querySelector('span')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      expect(component.hoveredMarkedContent()).toBeNull();
    });

    it('should emit navigateToMarkedContentInParent on dblclick', async () => {
      const seg1 = createMockSegment('mc-1', 1);
      textSegmentationService.segments.set([seg1]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService.status.set('success');

      const mc1 = addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      simulateTextLayerRendered(1);
      await fixture.whenStable();

      let emitted: PdfJsAccessibleTextSegment | null = null;
      component.navigateToMarkedContentInParent.subscribe((event) => {
        emitted = event;
      });

      mc1.querySelector('span')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(emitted).toEqual({ pdfJsId: 'mc-1', page: 1 });
    });

    it('should apply primary color outline when selectedMarkedContent is set', async () => {
      const seg1 = createMockSegment('mc-1', 1);
      textSegmentationService.segments.set([seg1]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService.status.set('success');

      const mc1 = addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      simulateTextLayerRendered(1);
      await fixture.whenStable();

      component.selectedMarkedContent.set({ pdfJsId: 'mc-1', page: 1 });
      fixture.detectChanges();
      await fixture.whenStable();

      const span1 = mc1.querySelector('.marked-content-highlight') as HTMLSpanElement;
      expect(span1.style.outline).toContain('var(--primary-color)');
    });
  });

  describe('text-segment mode', () => {
    beforeEach(async () => {
      fixture = TestBed.createComponent(PdfViewer);
      fixture.componentRef.setInput('src', 'blob:test-pdf');
      fixture.componentRef.setInput('visible', true);
      fixture.componentRef.setInput('name', 'test-viewer');
      fixture.componentRef.setInput('highlightMode', 'text-segment');
      component = fixture.componentInstance;
      fixture.detectChanges();
      await fixture.whenStable();

      setupIframeDom();
    });

    it('should create in text-segment mode', () => {
      expect(component).toBeTruthy();
      expect(component.highlightMode()).toBe('text-segment');
    });

    it('should create a single highlight span on parent element encompassing linked children', async () => {
      const childSeg = createMockSegment('mc-2', 1);
      const parentSeg = createMockSegment('mc-1', 1, [childSeg]);

      textSegmentationService.segments.set([parentSeg]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService['addressableSegments'].add('mc-2');
      textSegmentationService.status.set('success');

      const mc1 = addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      const mc2 = addMarkedContentToPage('mc-2', 10, 30, 150, 20);

      simulateTextLayerRendered(1);
      await fixture.whenStable();

      const parentHighlight = mc1.querySelector('.marked-content-highlight') as HTMLSpanElement;
      const childHighlight = mc2.querySelector('.marked-content-highlight') as HTMLSpanElement;

      expect(parentHighlight).toBeTruthy();
      expect(childHighlight).toBeNull();
      expect(parentHighlight.style.top).toBe('calc(20% - 0.5rem)');
      expect(parentHighlight.style.left).toBe('calc(10% - 0.5rem)');
    });

    it('should set selectedMarkedContent to parent when clicking on child marked content', async () => {
      const childSeg = createMockSegment('mc-2', 1);
      const parentSeg = createMockSegment('mc-1', 1, [childSeg]);

      textSegmentationService.segments.set([parentSeg]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService['addressableSegments'].add('mc-2');
      textSegmentationService.status.set('success');

      addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      const mc2 = addMarkedContentToPage('mc-2', 10, 30, 150, 20);

      simulateTextLayerRendered(1);
      await fixture.whenStable();

      // Click on child mc-2
      mc2.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(component.selectedMarkedContent()).toEqual({ pdfJsId: 'mc-1', page: 1 });
    });

    it('should emit parent segment on dblclick when double clicking on child marked content', async () => {
      const childSeg = createMockSegment('mc-2', 1);
      const parentSeg = createMockSegment('mc-1', 1, [childSeg]);

      textSegmentationService.segments.set([parentSeg]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService['addressableSegments'].add('mc-2');
      textSegmentationService.status.set('success');

      addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      const mc2 = addMarkedContentToPage('mc-2', 10, 30, 150, 20);

      simulateTextLayerRendered(1);
      await fixture.whenStable();

      let emitted: PdfJsAccessibleTextSegment | null = null;
      component.navigateToMarkedContentInParent.subscribe((event) => {
        emitted = event;
      });

      mc2.querySelector('span')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(emitted).toEqual({ pdfJsId: 'mc-1', page: 1 });
    });

    it('should set hoveredMarkedContent to parent when hovering over child marked content', async () => {
      const childSeg = createMockSegment('mc-2', 1);
      const parentSeg = createMockSegment('mc-1', 1, [childSeg]);

      textSegmentationService.segments.set([parentSeg]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService['addressableSegments'].add('mc-2');
      textSegmentationService.status.set('success');

      addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      const mc2 = addMarkedContentToPage('mc-2', 10, 30, 150, 20);

      simulateTextLayerRendered(1);
      await fixture.whenStable();

      mc2.querySelector('span')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(component.hoveredMarkedContent()).toEqual({ pdfJsId: 'mc-1', page: 1 });
    });

    it('should dynamically update highlight spans when segment linking changes', async () => {
      const seg1 = createMockSegment('mc-1', 1);
      const seg2 = createMockSegment('mc-2', 1);

      textSegmentationService.segments.set([seg1, seg2]);
      textSegmentationService['addressableSegments'].add('mc-1');
      textSegmentationService['addressableSegments'].add('mc-2');
      textSegmentationService.status.set('success');

      const mc1 = addMarkedContentToPage('mc-1', 10, 20, 100, 20);
      const mc2 = addMarkedContentToPage('mc-2', 10, 40, 100, 20);

      simulateTextLayerRendered(1);
      await fixture.whenStable();

      // Initially both are separate parents
      expect(mc1.querySelector('.marked-content-highlight')).toBeTruthy();
      expect(mc2.querySelector('.marked-content-highlight')).toBeTruthy();

      // Now link seg2 into seg1
      const linkedSeg2 = createMockSegment('mc-2', 1);
      const linkedParentSeg1 = createMockSegment('mc-1', 1, [linkedSeg2]);
      textSegmentationService.segments.set([linkedParentSeg1]);
      fixture.detectChanges();
      await fixture.whenStable();

      // mc1 should have the highlight span, mc2 should have its highlight span removed
      expect(mc1.querySelector('.marked-content-highlight')).toBeTruthy();
      expect(mc2.querySelector('.marked-content-highlight')).toBeNull();

      // Now unlink seg2 back into separate parent
      textSegmentationService.segments.set([createMockSegment('mc-1', 1), createMockSegment('mc-2', 1)]);
      fixture.detectChanges();
      await fixture.whenStable();

      // Both should have highlight spans again
      expect(mc1.querySelector('.marked-content-highlight')).toBeTruthy();
      expect(mc2.querySelector('.marked-content-highlight')).toBeTruthy();
    });
  });

  describe('findParentSegment helper in TextSegmentationService', () => {
    it('should find parent segment for parent and child IDs, and return null for unknown IDs', () => {
      const childSeg = createMockSegment('child-1', 1);
      const parentSeg = createMockSegment('parent-1', 1, [childSeg]);
      textSegmentationService.segments.set([parentSeg]);

      expect(textSegmentationService.findParentSegment('parent-1')).toBe(parentSeg);
      expect(textSegmentationService.findParentSegment('child-1')).toBe(parentSeg);
      expect(textSegmentationService.findParentSegment('unknown-id')).toBeNull();
    });
  });
});

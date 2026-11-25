import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { TextSegmentation } from './text-segmentation';
import { MediaFiles } from '../../../services/media-files/media-files';
import { TextSegmentationService, type TextSegment } from '../../../services/text-segmentation/text-segmentation';
import { TextAutoSegmentationService } from '../../../services/text-auto-segmentation/text-auto-segmentation';
import { InfoCard } from '../../common/info-card/info-card';

describe('TextSegmentation', () => {
  let component: TextSegmentation;
  let fixture: ComponentFixture<TextSegmentation>;
  let mediaFilesService: MediaFiles;
  let textSegmentationService: TextSegmentationService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextSegmentation],
    }).compileComponents();

    fixture = TestBed.createComponent(TextSegmentation);
    fixture.componentRef.setInput('visible', true);
    component = fixture.componentInstance;
    mediaFilesService = TestBed.inject(MediaFiles);
    textSegmentationService = TestBed.inject(TextSegmentationService);
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('Info Cards', () => {
    it('should display error card when text record is invalid', () => {
      mediaFilesService.textRecord.set({ file: new File([], 'test.txt'), type: 'invalid', url: null });
      fixture.detectChanges();

      const InfoCards = fixture.debugElement.queryAll(By.directive(InfoCard));
      const leftInfoCard = InfoCards.find((card) => card.nativeElement.hasAttribute('left'));
      expect(leftInfoCard).toBeTruthy();
      expect(leftInfoCard?.componentInstance.type()).toBe('error');
      expect(leftInfoCard?.componentInstance.message()).toBe('Registro de texto inválido.');
    });

    it('should display warning card when text record is not selected', () => {
      mediaFilesService.textRecord.set({ file: null, type: null, url: null });
      fixture.detectChanges();

      const InfoCards = fixture.debugElement.queryAll(By.directive(InfoCard));
      const leftInfoCard = InfoCards.find((card) => card.nativeElement.hasAttribute('left'));
      expect(leftInfoCard).toBeTruthy();
      expect(leftInfoCard?.componentInstance.type()).toBe('warning');
      expect(leftInfoCard?.componentInstance.message()).toBe('Registro de texto não selecionado.');
    });

    it('should display loading segments card when segmentation status is loading', () => {
      mediaFilesService.textRecord.set({ file: new File([], 'doc.pdf'), type: 'application/pdf', url: 'blob:test' });
      textSegmentationService.status.set('loading');
      fixture.detectChanges();

      const InfoCards = fixture.debugElement.queryAll(By.directive(InfoCard));
      const leftInfoCard = InfoCards.find((card) => card.nativeElement.hasAttribute('left'));
      expect(leftInfoCard).toBeTruthy();
      expect(leftInfoCard?.componentInstance.type()).toBe('loading-segments');
      expect(leftInfoCard?.componentInstance.message()).toBe('Extraindo texto do registro de texto...');
    });
  });

  describe('Segment Actions', () => {
    const mockSegments: TextSegment[] = [
      {
        sequentialId: 0,
        pdfJsId: 'seg-1',
        page: 1,
        text: 'Parent segment 1',
        excluded: false,
        linkedChildren: [
          {
            sequentialId: 1,
            pdfJsId: 'seg-2',
            page: 1,
            text: 'Child segment 1',
            excluded: false,
            linkedChildren: [],
          },
        ],
      },
      {
        sequentialId: 2,
        pdfJsId: 'seg-3',
        page: 2,
        text: 'Parent segment 2',
        excluded: true,
        linkedChildren: [],
      },
    ];

    beforeEach(() => {
      mediaFilesService.textRecord.set({ file: new File([], 'doc.pdf'), type: 'application/pdf', url: 'blob:test' });
      textSegmentationService.status.set('idle');
      textSegmentationService.segments.set(JSON.parse(JSON.stringify(mockSegments)));
      fixture.detectChanges();
    });

    it('should toggle segment linking on link button click', () => {
      const spy = vi.spyOn(textSegmentationService, 'toggleSegmentLinking');
      component['onLinkButtonClick'](mockSegments[1]);
      expect(spy).toHaveBeenCalledWith('seg-3');
    });

    it('should move segment up on up button click', () => {
      const spy = vi.spyOn(textSegmentationService, 'moveSegmentUp');
      component['onUpButtonClick'](mockSegments[1]);
      expect(spy).toHaveBeenCalledWith('seg-3');
    });

    it('should move segment down on down button click', () => {
      const spy = vi.spyOn(textSegmentationService, 'moveSegmentDown');
      component['onDownButtonClick'](mockSegments[0]);
      expect(spy).toHaveBeenCalledWith('seg-1');
    });

    it('should exclude segment on exclude button click', () => {
      const spy = vi.spyOn(textSegmentationService, 'excludeSegment');
      component['onExcludeButtonClick'](mockSegments[0]);
      expect(spy).toHaveBeenCalledWith('seg-1');
    });

    it('should include segment on include button click', () => {
      const spy = vi.spyOn(textSegmentationService, 'includeSegment');
      component['onIncludeButtonClick'](mockSegments[1]);
      expect(spy).toHaveBeenCalledWith('seg-3');
    });

    it('should select segment on click and navigate on double click', () => {
      component['onSegmentButtonClick']({ pdfJsId: 'seg-1', page: 1 });
      expect(component['selectedSegmentPdfJsId']()).toEqual({ pdfJsId: 'seg-1', page: 1 });

      component['onSegmentButtonDoubleClick']({ pdfJsId: 'seg-1', page: 1 });
      expect(component['navigateToMarkedContentInViewer']()).toEqual({ pdfJsId: 'seg-1', page: 1 });
    });

    it('should scroll segment into view when onNavigateToMarkedContent is triggered', () => {
      const scrollSpy = vi.fn();
      const mockElement = {
        nativeElement: {
          getAttribute: (attr: string) => (attr === 'data-segment-id' ? 'seg-1' : null),
          scrollIntoView: scrollSpy,
        },
      };
      (component as unknown as { segmentItems: () => typeof mockElement[] }).segmentItems = () => [mockElement];

      component['onNavigateToMarkedContent']({ pdfJsId: 'seg-1', page: 1 });
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    });
  });

  describe('Keyboard Navigation Highlight', () => {
    let list: HTMLOListElement;
    let segmentItem: HTMLLIElement;
    let mainButton: HTMLButtonElement;
    let linkButton: HTMLButtonElement;

    beforeEach(() => {
      list = document.createElement('ol');
      list.className = 'segments-list';

      segmentItem = document.createElement('li');
      segmentItem.setAttribute('data-segment-id', 'seg-1');
      segmentItem.setAttribute('data-segment-page', '3');
      segmentItem.className = 'parent-segment-item';

      mainButton = document.createElement('button');
      mainButton.className = 'segment-button';

      linkButton = document.createElement('button');
      linkButton.className = 'link-button';

      segmentItem.appendChild(mainButton);
      segmentItem.appendChild(linkButton);
      list.appendChild(segmentItem);
      document.body.appendChild(list);
    });

    afterEach(() => {
      document.body.removeChild(list);
    });

    it('should highlight segment when focusing on a segment button', () => {
      mainButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(component['hoveredSegmentPdfJsId']()).toEqual({ pdfJsId: 'seg-1', page: 3 });
    });

    it('should unhover segment when focusing on a link button', () => {
      // First highlight it
      mainButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(component['hoveredSegmentPdfJsId']()).toEqual({ pdfJsId: 'seg-1', page: 3 });

      // Focus link button
      linkButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(component['hoveredSegmentPdfJsId']()).toBeNull();
    });

    it('should unhover segment when focus leaves the segments list', () => {
      // First highlight it
      mainButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(component['hoveredSegmentPdfJsId']()).toEqual({ pdfJsId: 'seg-1', page: 3 });

      // Create an outside element and focus it
      const outsideElement = document.createElement('div');
      document.body.appendChild(outsideElement);
      outsideElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      expect(component['hoveredSegmentPdfJsId']()).toBeNull();
      document.body.removeChild(outsideElement);
    });

    it('should unhover segment when focus leaves the document entirely', () => {
      // First highlight it
      mainButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(component['hoveredSegmentPdfJsId']()).toEqual({ pdfJsId: 'seg-1', page: 3 });

      // Dispatch focusout with no related target
      document.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
      expect(component['hoveredSegmentPdfJsId']()).toBeNull();
    });
  });
  describe('Header and Automatic Segmentation', () => {
    let autoService: TextAutoSegmentationService;

    beforeEach(() => {
      autoService = TestBed.inject(TextAutoSegmentationService);
      mediaFilesService.textRecord.set({
        file: new File([], 'doc.pdf'),
        type: 'application/pdf',
        url: 'blob:test'
      });
      textSegmentationService.status.set('idle');
      textSegmentationService.segments.set([
        {
          sequentialId: 0,
          pdfJsId: 's1',
          page: 1,
          text: 'Seg 1',
          excluded: false,
          linkedChildren: []
        }
      ]);
      fixture.detectChanges();
    });

    it('should display the header with magic button and initial dash indicators', () => {
      const header = fixture.debugElement.query(By.css('.segments-header'));
      expect(header).toBeTruthy();

      const magicButton = fixture.debugElement.query(By.css('.magic-button'));
      expect(magicButton).toBeTruthy();
      expect(magicButton.nativeElement.getAttribute('aria-label')).toBe('Executar segmentação automática de texto');

      const indicators = fixture.debugElement.query(By.css('.header-indicators'));
      expect(indicators).toBeTruthy();
      expect(indicators.nativeElement.textContent).toContain('Junções: -');
      expect(indicators.nativeElement.textContent).toContain('Segmentos: -');
      expect(indicators.nativeElement.textContent).toContain('Confiança: -%');
    });

    it('should show spinner icon and aria-busy when model is downloading', () => {
      autoService.isDownloading.set(true);
      fixture.detectChanges();

      const spinner = fixture.debugElement.query(By.css('.spinner-icon'));
      expect(spinner).toBeTruthy();

      const magicButton = fixture.debugElement.query(By.css('.magic-button'));
      expect(magicButton.nativeElement.disabled).toBe(true);
      expect(magicButton.nativeElement.getAttribute('aria-busy')).toBe('true');
    });

    it('should trigger onAutoSegmentButtonClick when magic button is clicked', async () => {
      const autoSegmentSpy = vi.spyOn(autoService, 'autoSegment').mockResolvedValue({
        newSegments: textSegmentationService.segments(),
        junctions: 3,
        segmentsCount: 2,
        confidence: 96
      });

      const magicButton = fixture.debugElement.query(By.css('.magic-button'));
      magicButton.nativeElement.click();
      await fixture.whenStable();

      expect(autoSegmentSpy).toHaveBeenCalled();
    });

    it('should update indicators when auto-segmentation values are available', () => {
      autoService.junctions.set(7);
      autoService.segmentsCount.set(4);
      autoService.confidence.set(98);
      fixture.detectChanges();

      const indicators = fixture.debugElement.query(By.css('.header-indicators'));
      expect(indicators.nativeElement.textContent).toContain('Junções: 7');
      expect(indicators.nativeElement.textContent).toContain('Segmentos: 4');
      expect(indicators.nativeElement.textContent).toContain('Confiança: 98%');
    });

    it('should reset indicators when a non-pdf text record is selected', () => {
      autoService.junctions.set(7);
      autoService.segmentsCount.set(4);
      autoService.confidence.set(98);
      fixture.detectChanges();

      mediaFilesService.textRecord.set({ file: null, type: null, url: null });
      fixture.detectChanges();

      expect(autoService.junctions()).toBeNull();
      expect(autoService.segmentsCount()).toBeNull();
      expect(autoService.confidence()).toBeNull();
    });
  });
});

import { TestBed } from '@angular/core/testing';
import { TextAutoSegmentationService } from './text-auto-segmentation';
import { GBDTEvaluator, type GbdtModelJson } from './evaluator/gbdt-evaluator';
import { extractBoundaryFeatures } from './evaluator/feature-extractor';
import { type TextSegment } from '../text-segmentation/text-segmentation';

describe('TextAutoSegmentationService & Evaluator Pipeline', () => {
  let service: TextAutoSegmentationService;

  const sampleModelJson: GbdtModelJson = {
    name: 'gbdt_universal_test',
    version: '1.0.0',
    num_features: 30,
    feature_names: Array.from({ length: 30 }, (_, i) => `f${i}`),
    tree_info: [
      {
        tree_structure: {
          // ends_with_terminal_punct
          split_feature: 18,
          threshold: 0.5,
          left_child: {
            // JOIN if not terminal punct
            leaf_value: 1.5,
          },
          right_child: {
            // SPLIT if terminal punct
            leaf_value: -2.0,
          },
        }
      }
    ]
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TextAutoSegmentationService]
    });
    service = TestBed.inject(TextAutoSegmentationService);
  });

  describe('Feature Extractor', () => {
    it('should compute 30 features with valid geometry for same-page pieces', () => {
      const pieceA = {
        text: 'Primeiro parágrafo de teste.',
        page: 1,
        bbox: [100, 100, 400, 120] as [number, number, number, number],
        fontSize: 12,
        fontName: 'Arial-Bold',
        isBold: true,
        isItalic: false
      };
      const pieceB = {
        text: 'Segundo parágrafo.',
        page: 1,
        bbox: [100, 130, 350, 150] as [number, number, number, number],
        fontSize: 12,
        fontName: 'Arial-Bold',
        isBold: true,
        isItalic: false
      };

      const feats = extractBoundaryFeatures(pieceA, pieceB);
      expect(feats.length).toBe(30);

      // samePage
      expect(feats[0]).toBe(1.0);

      // dy = yb0 - ya1 = 130 - 120 = 10
      expect(feats[1]).toBe(10.0);

      // dx = xb0 - xa0 = 100 - 100 = 0
      expect(feats[2]).toBe(0.0);

      // widthA = 300, heightA = 20
      expect(feats[3]).toBe(300.0);
      expect(feats[4]).toBe(20.0);

      // ends_with_terminal_punct (index 18)
      expect(feats[18]).toBe(1.0);

      // same_bold (index 12)
      expect(feats[12]).toBe(1.0);

      // is_cyrillic (index 29)
      expect(feats[29]).toBe(0.0);
    });

    it('should assign cross-page dy of 50.0 when pages differ', () => {
      const pieceA = { text: 'Página um', page: 1 };
      const pieceB = { text: 'Página dois', page: 2 };

      const feats = extractBoundaryFeatures(pieceA, pieceB);

      // same_page
      expect(feats[0]).toBe(0.0);

      // dy
      expect(feats[1]).toBe(50.0);

      // is_same_line
      expect(feats[14]).toBe(0.0);
    });

    it('should detect Cyrillic characters in either piece', () => {
      const pieceA = { text: 'Привет мир', page: 1 };
      const pieceB = { text: 'Продолжение текста', page: 1 };

      const feats = extractBoundaryFeatures(pieceA, pieceB);

      // is_cyrillic
      expect(feats[29]).toBe(1.0);
    });

    it('should detect bullet markers and section codes', () => {
      const bulletA = { text: '•', page: 1 };
      const pieceB = { text: 'Item da lista', page: 1 };

      const feats = extractBoundaryFeatures(bulletA, pieceB);

      // is_bullet_a
      expect(feats[25]).toBe(1.0);

      // is_short_label_a
      expect(feats[27]).toBe(1.0);
    });

    it('should detect inverted punctuation in Spanish and quotes', () => {
      const pieceA = { text: 'Introducción:', page: 1 };
      const pieceB = { text: '¿Cómo funciona?', page: 1 };

      const feats = extractBoundaryFeatures(pieceA, pieceB);

      // ends_with_soft_punct (:)
      expect(feats[19]).toBe(1.0);

      // starts_with_inverted_punct (¿)
      expect(feats[28]).toBe(1.0);

      // starts_with_uppercase (C)
      expect(feats[23]).toBe(1.0);
    });

    it('should gracefully handle missing layout attributes with defaults', () => {
      const pieceA = { text: 'Texto simples A' };
      const pieceB = { text: 'Texto simples B' };

      const feats = extractBoundaryFeatures(pieceA, pieceB);
      expect(feats.length).toBe(30);

      // default font_size_a
      expect(feats[7]).toBe(10.0);

      // default font_size_b
      expect(feats[8]).toBe(10.0);
    });
  });

  describe('GBDTEvaluator', () => {
    let evaluator: GBDTEvaluator;

    beforeEach(() => {
      evaluator = new GBDTEvaluator(sampleModelJson);
    });

    it('should compute valid sigmoid probabilities', () => {
      const featuresNoTerminal = new Array(30).fill(0);

      // not terminal -> leaf 1.5 -> prob ~ 0.817
      featuresNoTerminal[18] = 0.0;
      const p1 = evaluator.predictProba(featuresNoTerminal);
      expect(p1).toBeGreaterThan(0.8);

      const featuresWithTerminal = new Array(30).fill(0);

      // terminal -> leaf -2.0 -> prob ~ 0.119
      featuresWithTerminal[18] = 1.0;
      const p2 = evaluator.predictProba(featuresWithTerminal);
      expect(p2).toBeLessThan(0.2);
    });

    it('predictCascade should enforce Rule 1: bullet marker joins immediately', () => {
      const feats = new Array(30).fill(0);
      const res = evaluator.predictCascade(feats, { text: '•' }, { text: 'Item' });
      expect(res.decision).toBe(1);
      expect(res.confidence).toBe(1.0);
      expect(res.reason).toContain('Bullet marker');
    });

    it('predictCascade should enforce Rule 2: requirement section code joins immediately', () => {
      const feats = new Array(30).fill(0);
      const res = evaluator.predictCascade(feats, { text: 'RF1' }, { text: 'Descrição da funcionalidade' });
      expect(res.decision).toBe(1);
      expect(res.confidence).toBe(0.99);
      expect(res.reason).toContain('Requirement/Section ID');
    });

    it('predictCascade should enforce Rule 3: hyphenated word continuation joins immediately', () => {
      const feats = new Array(30).fill(0);
      const res = evaluator.predictCascade(feats, { text: 'desenvolvi-' }, { text: 'mento de sistemas' });
      expect(res.decision).toBe(1);
      expect(res.confidence).toBe(0.99);
      expect(res.reason).toContain('Hyphenated word continuation');
    });

    it('should correctly apply Platt calibration when configured in model JSON', () => {
      const calibratedModelJson: GbdtModelJson = {
        ...sampleModelJson,
        calibration: {
          method: 'platt',
          a: 0.98908,
          b: 0.983641,
        },
      };
      const calEvaluator = new GBDTEvaluator(calibratedModelJson);

      const featuresNoTerminal = new Array(30).fill(0);
      featuresNoTerminal[18] = 0.0;

      const rawScore = calEvaluator.predictRawScore(featuresNoTerminal);
      expect(rawScore).toBe(1.5);

      // Calibrated logit = (0.98908 * 1.5) + 0.983641 = 2.467261
      // Calibrated prob = 1 / (1 + exp(-2.467261)) ~= 0.9218
      const calProb = calEvaluator.predictProba(featuresNoTerminal);
      expect(calProb).toBeCloseTo(0.9218, 3);

      // Uncalibrated prob = 1 / (1 + exp(-1.5)) ~= 0.8176
      const uncalProb = evaluator.predictProba(featuresNoTerminal);
      expect(uncalProb).toBeCloseTo(0.8176, 3);
    });
  });

  describe('TextAutoSegmentationService Lifecycle & Mechanics', () => {
    it('should have initial null metrics (rendering as dashes in the UI)', () => {
      expect(service.junctions()).toBeNull();
      expect(service.segmentsCount()).toBeNull();
      expect(service.confidence()).toBeNull();
      expect(service.isDownloading()).toBe(false);
      expect(service.isProcessing()).toBe(false);
    });

    it('reset() should reset indicators back to null', () => {
      service.junctions.set(5);
      service.segmentsCount.set(3);
      service.confidence.set(95);

      service.reset();

      expect(service.junctions()).toBeNull();
      expect(service.segmentsCount()).toBeNull();
      expect(service.confidence()).toBeNull();
    });

    it('autoSegment() should handle empty and single-element segment lists', async () => {
      const emptyResult = await service.autoSegment([]);
      expect(emptyResult.newSegments.length).toBe(0);
      expect(emptyResult.junctions).toBe(0);
      expect(emptyResult.segmentsCount).toBe(0);
      expect(emptyResult.confidence).toBe(0);

      const singleSegment: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p0',
        page: 1,
        text: 'Segmento único',
        excluded: false,
        linkedChildren: []
      };

      const singleResult = await service.autoSegment([singleSegment]);
      expect(singleResult.newSegments.length).toBe(1);
      expect(singleResult.junctions).toBe(0);
      expect(singleResult.segmentsCount).toBe(1);
      expect(singleResult.confidence).toBe(100);
      expect(service.junctions()).toBe(0);
      expect(service.segmentsCount()).toBe(1);
      expect(service.confidence()).toBe(100);
    });

    it('autoSegment() should cluster multi-piece documents and set metrics signals', async () => {
      service.setCustomEvaluator(new GBDTEvaluator(sampleModelJson));

      const segments: TextSegment[] = [
        {
          sequentialId: 0,
          pdfJsId: 'mc0',
          page: 1,
          text: '•',
          excluded: false,
          linkedChildren: []
        },
        {
          sequentialId: 1,
          pdfJsId: 'mc1',
          page: 1,
          text: 'Primeiro item da lista com ponto final.',
          excluded: false,
          linkedChildren: []
        },
        {
          sequentialId: 2,
          pdfJsId: 'mc2',
          page: 1,
          text: 'Novo parágrafo independente.',
          excluded: false,
          linkedChildren: []
        }
      ];

      const result = await service.autoSegment(segments);

      // Boundary 0: '•' -> 'Primeiro item...' => Rule 1 JOIN
      // Boundary 1: '...ponto final.' -> 'Novo parágrafo...' => GBDT terminal punct leaf -2.0 => SPLIT
      expect(result.junctions).toBe(1);
      expect(result.segmentsCount).toBe(2);
      expect(result.confidence).toBeGreaterThan(0);

      expect(result.newSegments.length).toBe(2);
      expect(result.newSegments[0].text).toBe('•');
      expect(result.newSegments[0].linkedChildren.length).toBe(1);
      expect(result.newSegments[0].linkedChildren[0].text).toBe('Primeiro item da lista com ponto final.');
      expect(result.newSegments[1].text).toBe('Novo parágrafo independente.');

      // Check reactive signals
      expect(service.junctions()).toBe(1);
      expect(service.segmentsCount()).toBe(2);
      expect(service.confidence()).toBe(result.confidence);
    });

    it('flattenSegments() should traverse hierarchical children in document order', () => {
      const hierarchical: TextSegment[] = [
        {
          sequentialId: 0,
          pdfJsId: 'p0',
          page: 1,
          text: 'Parent 0',
          excluded: false,
          linkedChildren: [
            {
              sequentialId: 1,
              pdfJsId: 'c1',
              page: 1,
              text: 'Child 1',
              excluded: false,
              linkedChildren: [
                {
                  sequentialId: 2,
                  pdfJsId: 'c2',
                  page: 1,
                  text: 'Grandchild 2',
                  excluded: false,
                  linkedChildren: []
                }
              ]
            }
          ]
        },
        {
          sequentialId: 3,
          pdfJsId: 'p3',
          page: 1,
          text: 'Parent 3',
          excluded: false,
          linkedChildren: []
        }
      ];

      const flat = service.flattenSegments(hierarchical);
      expect(flat.length).toBe(4);
      expect(flat.map((s) => s.sequentialId)).toEqual([0, 1, 2, 3]);
      expect(flat.every((s) => s.linkedChildren.length === 0)).toBe(true);
    });
  });
});

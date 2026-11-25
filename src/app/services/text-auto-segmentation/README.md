# Text Auto-Segmentation Service

The `TextAutoSegmentationService` automates document text boundary detection and phrase joining directly in the browser
using a high-performance Universal Gradient Boosted Decision Tree (GBDT) model. It eliminates tedious manual linking of
line-broken paragraphs, headings, and continuous prose in digitized PDF documents.

---

## 1. Architectural Overview & Universal GBDT Model

The service uses a single Universal GBDT model trained on multilingual corpora across diverse document layouts. Rather
than deploying heavy server-side neural networks or complex language-specific models, the universal model evaluates
30 geometric and surface-lexical boundary features in pure TypeScript with microsecond latency.

### 1.1 Model Topology
- **Model File**: `public/models/gbdt_universal.json` (~1 MB JSON artifact).
- **Tree Count**: 300 decision trees generated from LightGBM.
- **Inference Runtime**: Pure client-side tree traversal in `GBDTEvaluator` (`gbdt-evaluator.ts`) without external
  runtime dependencies.
- **Decision Cascade**: The evaluator implements a 4-rule priority cascade (`predictCascade`):
  1. **Rule 1 (Paragraph Break)**: If the vertical gap between lines exceeds 1.75x line height, classify as
     a boundary break (split, label 0).
  2. **Rule 2 (Bullet/List Item)**: If the succeeding piece begins with a bullet marker or list index, classify as
     a boundary break (split, label 0).
  3. **Rule 3 (GBDT Classifier)**: Evaluate the 30-feature vector through the 300 boosted decision trees. If the
     sigmoid probability P(join) > 0.5, classify as a phrase continuation (join, label 1).
  4. **Rule 4 (Structural Fallback)**: If confidence is ambiguous or rules do not trigger, preserve boundary split (0).

---

## 2. Feature Extraction Pipeline (30 Features)

The `extractBoundaryFeatures` function (`feature-extractor.ts`) computes 30 continuous and binary features across
consecutive text piece boundaries (A, B) matching the training pipeline:

1. **Geometric & Layout Features (0–12)**:
   - Horizontal and vertical offsets (delta x0, delta y, gap x, delta width, delta height).
   - Relative position ratios (delta y / hA, gap x / wA, wB / wA, hB / hA).
   - Right-edge alignment differences and column progression indicators.
2. **Font & Styling Features (13–16)**:
   - Font size delta and ratio (fontSizeB / fontSizeA).
   - Font family match flag (`font_name_matches`).
   - Font weight and slant matches (`is_bold_matches`, `is_italic_matches`).
3. **Lexical & Punctuation Features (17–29)**:
   - Character counts (lenA, lenB) and word counts.
   - Punctuation cues on piece A (hyphenation, terminal punctuation, commas, colons, open brackets).
   - Capitalization and bullet cues on piece B (starts uppercase, starts lowercase, starts digit, bullet pattern).

---

## 3. PDF Coordinate System Transformation

PDF.js specifies glyph bounding boxes using bottom-up Cartesian coordinates (y=0 at the bottom of the page).
However, PyMuPDF and the GBDT training pipeline use top-down coordinates (y=0 at the top of the page).
During text extraction in `TextSegmentationService`, coordinates are transformed:
$$
y_0 = -ty - h, \quad y_1 = -ty
$$
This ensures delta y = y0,B - y1,A is positive for typical downward reading order, matching the model's
trained decision thresholds.

---

## 4. Sequential Segmentation Algorithm & Metric Calculation

When `autoSegment()` is called:
1. **Flattening**: The hierarchical `TextSegment[]` tree is flattened into a sequential list of individual text pieces.
2. **Model Initialization**: If the model is not yet loaded, `ensureModelLoaded()` downloads the JSON asset and parses
   it into `GBDTEvaluator`.
3. **Boundary Evaluation**:
   - For each adjacent pair (Pi, Pi+1), `predictCascade` determines whether Pi+1 continues Pi.
   - If join is predicted (1), Pi+1 is appended as a linked child of the active parent segment.
   - If split is predicted (0), Pi+1 starts a new parent segment.
4. **Metrics Computation**:
   - **Junctions**: Total number of join operations performed.
   - **Segments Count**: Total number of resulting top-level parent segments.
   - **Confidence**: Average probability across all positive join decisions (percentage formatted).

---

## 5. Reactive State Management & Ingestion Reset

The service exposes readonly signals for seamless UI data binding:
- `junctions: Signal<number | null>`: Number of auto-generated junctions (or `null` before running).
- `segmentsCount: Signal<number | null>`: Number of final parent segments (or `null` before running).
- `confidence: Signal<number | null>`: Aggregate join confidence percentage (or `null` before running).
- `isDownloading: Signal<boolean>`: `true` while the JSON model is being retrieved over the network.
- `isProcessing: Signal<boolean>`: `true` while feature extraction and inference tree traversal execute.

### Ingestion Reset Contract
Whenever a new PDF document is loaded or ingested into the application:
1. `TextSegmentationService.segmentText()` automatically invokes `TextAutoSegmentationService.reset()`.
2. All indicators (`junctions`, `segmentsCount`, `confidence`) reset to `null`.
3. The UI immediately displays dashes (`-`) according to user requirements.

---

## 6. Testing & Zero-Network Mocking

To support deterministic Vitest execution in Node.js environments (where relative HTTP fetches fail):
- `setCustomEvaluator(evaluator: GBDTEvaluator | null)` allows unit tests to inject a pre-constructed evaluator or mock.
- `resetForTesting()` restores the service to clean initial state between test suites.

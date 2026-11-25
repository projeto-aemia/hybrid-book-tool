# Text Segmentation Component

The `TextSegmentationComponent` provides the user interface for document text segmentation. It features a two-column
split view synchronizing interactive visual page previews from the PDF viewer with an editable, hierarchical segment
tree. Users can review, adjust, manually link/unlink, exclude, and automatically segment document text using a
client-side Universal GBDT machine learning model.

---

## 1. Component Architecture & Split Layout

The component is composed of two primary interactive panels within `.split-container`:
1. **PDF Preview (`<app-pdf-preview>`)**:
   - Renders the document using `ngx-extended-pdf-viewer`.
   - Listens to text layer click events and highlights corresponding segments in the right panel.
2. **Text Segments Card (`.segments-card`)**:
   - Displays the list of segmented phrases, headings, and paragraphs.
   - Contains the top card header with automated segmentation controls and real-time inference indicators.

---

## 2. Card Header & Automated Segmentation Controls

The header (`.segments-header`) provides automated phrase joining at the top of the segments card:

### 2.1 The Magic Button
- Located on the left side of the header.
- Displays a magic wand icon (placeholder SVG tagged with `DEV: Replace placeholder magic icon with final asset`).
- While the GBDT model JSON is downloading over the network (`isDownloading()`), the magic icon is replaced by a
  rotating spinner (`.spinner-icon`).
- The button is disabled when:
  - Model download is in progress (`isDownloading()`).
  - Segmentation inference is executing (`isProcessing()`).
  - No PDF document is currently loaded.
- Clicking the button triggers `onAutoSegmentButtonClick()`, which runs the auto-segmentation pipeline and registers
  a snapshot-based `TextSegmentationCommand` with `UndoRedoService`.

### 2.2 Status Indicators
Located on the right side of the header (`.header-indicators`), presenting three key metrics:
1. **"Junções: -"**: Total number of boundary joins created by the algorithm.
2. **"Segmentos: -"**: Total number of resulting parent segments after joining.
3. **"Confiança: -%"**: Average model confidence percentage across all joined boundaries.

#### Styling & Reset Semantics
- Prior to running the model, all three indicators display a dash (`-`).
- Both the dashes and the computed numerical values are highlighted with `--primary-color`.
- When a new PDF is ingested or loaded, the indicators automatically reset to dashes (`-`).

---

## 3. Undo/Redo Integration

Automated segmentation is fully integrated into the application's global undo/redo infrastructure:
- Before running the model, a deep clone of the current segment tree is captured (`beforeSegments`).
- After inference finishes and the segment tree is updated, a second clone is captured (`afterSegments`).
- A `TextSegmentationCommand` is pushed onto `UndoRedoService`.
- Pressing Undo restores the manual segment configuration; pressing Redo re-applies the automated joins.

---

## 4. Accessibility (a11y) Design

The component adheres to modern accessibility guidelines:
- **ARIA Live Regions**: The indicator panel has `aria-live="polite"` and `aria-atomic="true"`, ensuring assistive
  technologies announce updated metrics when auto-segmentation completes.
- **Button Semantics**: The magic button includes explicit `aria-label="Segmentar texto automaticamente"` and
  dynamic `aria-busy="true"` when the model is downloading or processing.
- **Accessible Loading Text**: A visually hidden `span.sr-only` element announces `"Carregando modelo..."` during
  download state.
- **Reduced Motion Support**: The `@keyframes spin` animation is scoped within
  `@media (prefers-reduced-motion: reduce)`, ensuring users with vestibular motion disorders are not presented with
  continuous spinning animations.
- **Keyboard Navigation**: All segmentation buttons, manual link toggles, and exclusion controls are keyboard accessible
  via Tab, Space, and Enter.

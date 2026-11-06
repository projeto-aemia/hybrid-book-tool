# Hybrid Book Creation Tool

**Web tool for creating accessible hybrid books** developed as part of the **ÆMIA** (*Acessibilidade e Emoções Mediadas por Inteligência Artificial*) interdisciplinary macroproject at the **Federal University of Pelotas (UFPel)**.

[![Angular](https://img.shields.io/badge/Angular-22-dd0031.svg?logo=angular)](https://angular.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![License: GPL v3+](https://img.shields.io/badge/License-GPLv3%2B-blue.svg)](LICENSE)

---

## 1. Overview & Context

The **Hybrid Book Creation Tool** is an open-source, web-based authoring environment built with Angular. It allows educators, translators, and content creators to produce Hybrid Book publications directly in a web browser without requiring local software installation or specialized video editing knowledge.

### Institutional Background
- **ÆMIA macroproject**: Centro de Desenvolvimento Tecnológico (CDTec) and Faculdade de Educação, Universidade Federal de Pelotas (UFPel).
- **Funding & Support**: Fundação de Amparo à Pesquisa do Estado do Rio Grande do Sul (**FAPERGS**), Grant/Process No. 25/2551-0002636-9.

---

## 2. Workflow
The application implements a five-stage sequential authoring pipeline:

1. **Media Ingestion**:
   - Import textual PDF documents and video recordings (MP4, WebM, etc.).

2. **Text Segmentation**:
   - Marked content linking and reordering forming text segments.

3. **Video Segmentation**:
   - Cut videos into video segment strips.

4. **Correlation**:
   - Video segment reordering correlating video segments with text segments.

5. **Packaging & Export**:
   - Edit publication metadata (title, author, publisher, ISBN, year, translator, editorial revision).
   - Generate standard Hybrid Book 3.0 packages in a ZIP file.
   - The Hybrid Book 3.0 specification does not define a text record format, a specification for mapping phases in the PDF text record is available at [PDF_TEXT_RECORD_PHRASE_MAP.md](PDF_TEXT_RECORD_PHRASE_MAP.md).

---

## 3. Technology Stack

- **Framework**: [Angular 22](https://angular.dev/) (Zoneless Change Detection, Signals, Standalone Components, SSR).
- **Language**: [TypeScript 5.x](https://www.typescriptlang.org/) & SCSS.
- **Media & Processing**:
  - [Mediabunny](https://mediabunny.dev/): High-performance client-side video decoding and frame
    capture.
  - [ngx-extended-pdf-viewer](https://pdfviewer.net/): PDF rendering and text layer interaction.
  - [zip.js](https://gildas-lormeau.github.io/zip.js/): Streaming ZIP file packaging in the browser.
  - [MediaPipe Pose Lankmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker): Pose landmarking from video streams.
- **Testing & Tooling**:
  - [Vitest](https://vitest.dev/): Unit testing.
  - [Angular ESLint](https://github.com/angular-eslint/angular-eslint): Linting and stylistic analysis.

---

## 6. Getting Started & Compilation

### Prerequisites
- [Node.js](https://nodejs.org/) (version `20.x` or later recommended)
- `npm` (version `10.x` or later)

### Installation
Clone the repository and install project dependencies:

```bash
git clone https://github.com/lsuperti/hybrid-book-tool
cd hybrid-book-tool
npm install
```

### Development Server
Start the local development server:

```bash
npm start
# or
ng serve
```

Navigate to `http://localhost:4200/` in your browser. The application will automatically reload on source changes.

### Production Build
To create an optimized production build:

```bash
npm run build
```

Build outputs are generated in the `dist/hybrid-book-tool` directory, including both client browser assets and
Server-Side Rendering (SSR) bundles.

### Server-Side Rendering (SSR)
To test the pre-rendered SSR server locally after building:

```bash
npm run serve:ssr:hybrid-book-tool
```

---

## 7. Testing & Quality Assurance

Code quality and test coverage are enforced across the entire source tree:

### Unit Tests
Run the complete test suite using Vitest:

```bash
npm test -- --watch=false
# or
ng test --watch=false
```

For continuous test execution during development:
```bash
npm test
```

### Code Linting
Run static code analysis:

```bash
npm run lint
# or
ng lint
```

### Production Comment Check
To ensure that temporary development tags (e.g. debug stubs or unapproved comments) do not leak into releases:

```bash
npm run check-comments:prod
```

---

## 8. Contribution Guidelines

Contributions are welcome! Please adhere to the following standards:

1. **Architecture & Framework Rules**:
   - Write modern Angular code: use Signals, `computed()`, `inject()`, `linkedSignal()`, and zoneless patterns.
   - Do not introduce legacy NgModule or Zone.js dependencies.
2. **Style & Code Quality**:
   - Follow the [`STYLEGUIDE.md`](STYLEGUIDE.md).
   - Keep maximum line width under 120 characters where applicable.
   - Use JSDoc headers `/** ... */` on all non-trivial methods, documenting parameters, return values, and thrown exceptions.
3. **Accessibility**:
   - Any new UI component must satisfy WCAG 2.2 Level AA / ABNT NBR 17225:2025.
   - Ensure proper contrast, keyboard navigation, visible focus indicators, and accessible labels.
4. **Verification**:
   - Ensure `npm run lint`, `npm test -- --watch=false`, and `npm run check-comments:prod` pass before submitting pull requests.

---

## 9. License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE), for more details.

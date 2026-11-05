# Landmark Extraction Service

The `LandmarkExtractionService` coordinates client-side video frame decoding with Mediabunny and pose landmark
inference via MediaPipe Tasks Vision (`@mediapipe/tasks-vision`) to supply kinematic landmarks for sign language
video segmentation.

---

## 1. Architectural Overview & Hardware Acceleration

The service coordinates hardware video decoding and deep learning inference directly inside the web browser:

```
┌────────────────────────────────────────────────────────┐
│                   User Ingested Video                  │
│                     (File / Blob)                      │
└──────────────────────────┬─────────────────────────────┘
                           │
                 Mediabunny Input Track
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               Mediabunny CanvasSink                    │
│    (Downsamples frames to <= 256px max dimension)      │
└──────────────────────────┬─────────────────────────────┘
                           │
                 HTML5 / Offscreen Canvas
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│          MediaPipe Pose Landmarker (Lite)              │
│      (WebGL/WebGPU Delegate with CPU Fallback)         │
└──────────────────────────┬─────────────────────────────┘
                           │
               33 Normalized 3D Landmarks
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│            Landmarks Cache & Segmentation              │
│                 (VideoLandmarksData)                   │
└────────────────────────────────────────────────────────┘
```

1. **Mediabunny `CanvasSink`**: Decodes video frames at approximately 5 frames per second ($0.2\,\text{s}$ interval)
   directly from the container format without loading uncompressed video into memory.
2. **MediaPipe Tasks Vision `PoseLandmarker`**: Executes inference using the lightweight model
   (`pose_landmarker_lite.task`), running in `VIDEO` tracking mode for sequential temporal stability.
3. **Hardware Delegates**: Prefers WebGL GPU delegation (`delegate: 'GPU'`) and automatically falls back to CPU
   WebAssembly execution if hardware acceleration is unavailable.

---

## 2. Low-Framerate Frame Subsampling (5 FPS)

Full-framerate landmarking ($30\text{--}60\,\text{FPS}$) is computationally prohibitive on low-powered client devices.
Because active signing movements are temporally stable across tenth-of-a-second windows:

- The service samples frames at $f = 5\,\text{FPS}$ ($\Delta t = 0.2\,\text{s}$).
- For a video of duration $D$, timestamps are computed as $t_k = k \times 0.2$ for $k = 0, 1, \dots, \lfloor 5D \rfloor$.
- Clamped timestamps prevent seeking past track boundaries.
- No frame interpolation is needed, as the downstream signing heuristic is inherently robust to frame boundaries.

---

## 3. Non-Blocking Event Loop Architecture

MediaPipe inference is CPU/GPU intensive and blocks synchronously during individual frame evaluations. To prevent
application freezing and allow the user to freely navigate other views, edit texts, or perform undo operations:

- **Macro-Task Yielding**: After evaluating each frame, execution explicitly yields to the browser macro-task queue
  via `await new Promise((resolve) => setTimeout(resolve, 0))`.
- **Responsive UI**: The browser processes user clicks, rendering passes, animations, and tab changes seamlessly.
- **Reactive Progress**: Progress callbacks emit real-time metrics (`currentFrame`, `totalFrames`, `progressPercentage`)
  consumed by components with accessible ARIA live regions (`aria-live="polite"`).

---

## 4. Cancellation & Resource Management

- **Cooperative Cancellation**: Accepts standard `AbortSignal` handles. Aborting halts `CanvasSink` streaming
  immediately, releases canvas buffers, and disposes the Mediabunny `Input` instance.
- **Memory Optimization**: Canvas resolution is constrained to a maximum dimension of 256 pixels, matching the
  internal receptive field of the Lite Pose model and saving GPU fill bandwidth.
- **In-Memory Caching**: Extracted landmark data is indexed by `MediaFileId`. Changing heuristic thresholds ($\lambda$)
  operates instantaneously on cached landmarks without triggering duplicate inference passes.
- **Lifecycle Cleanup**: On application destruction (`DestroyRef.onDestroy`), active decoding streams are aborted,
  cached records are released, and the `PoseLandmarker` WebAssembly instance is cleanly terminated.

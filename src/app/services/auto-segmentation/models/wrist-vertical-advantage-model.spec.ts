import { WristVerticalAdvantageModel } from './wrist-vertical-advantage-model';
import { type FramePoseLandmarks, type PoseLandmarkPoint } from '../../landmark-extraction/landmark-data.interface';

describe('WristVerticalAdvantageModel', () => {
  let model: WristVerticalAdvantageModel;

  beforeEach(() => {
    model = new WristVerticalAdvantageModel();
  });

  it('should initialize with correct id, name, and description', () => {
    expect(model.id).toBe('wrist-vertical-advantage');
    expect(model.name.toLowerCase()).toContain('vantagem vertical do punho');
    expect(model.description).toBeTruthy();
  });

  it('should return empty segments when landmarks array is empty', () => {
    const result = model.segment({
      landmarks: [],
      framerate: 5,
      duration: 0,
      lambda: 1.0,
    });
    expect(result.segments).toEqual([]);
    expect(result.activeRegions).toEqual([]);
  });

  it('should return empty segments when all landmarks are null/missing', () => {
    const landmarks: FramePoseLandmarks[] = [null, null];
    const result = model.segment({
      landmarks,
      framerate: 5,
      duration: 0.4,
      lambda: 1.0,
    });
    expect(result.segments).toEqual([]);
    expect(result.activeRegions).toEqual([]);
  });

  const createDummyLandmark = (y: number, x = 0.5, z = 0): PoseLandmarkPoint => ({
    x,
    y,
    z,
    visibility: 0.99,
  });

  const createFullFrame = (
    wristY: number,
    elbowY: number,
    wristX = 0.5,
  ): FramePoseLandmarks => {
    const points: PoseLandmarkPoint[] = Array.from({ length: 33 }, () => createDummyLandmark(0.5));

    // Index 11: left shoulder, 12: right shoulder
    points[11] = createDummyLandmark(0.4, 0.4, 0);
    points[12] = createDummyLandmark(0.4, 0.6, 0);

    // Index 13: left elbow, 14: right elbow
    points[13] = createDummyLandmark(elbowY, 0.35, 0);
    points[14] = createDummyLandmark(elbowY, 0.65, 0);

    // Index 15: left wrist, 16: right wrist
    points[15] = createDummyLandmark(wristY, wristX, 0);
    points[16] = createDummyLandmark(wristY, 1.0 - wristX, 0);

    return points;
  };

  it('should classify frames with wrists below elbows as rest (zero segments)', () => {
    const frames: FramePoseLandmarks[] = [];
    const framerate = 5;
    const totalFrames = 20;

    for (let i = 0; i < totalFrames; i++) {
      // In normalized coords, lower in space = higher Y (e.g. wrist at 0.8 is lower than elbow at 0.6)
      frames.push(createFullFrame(0.8, 0.6));
    }

    const result = model.segment({
      landmarks: frames,
      framerate,
      duration: totalFrames / framerate,
      lambda: 1.0,
    });

    expect(result.segments.length).toBe(0);
  });

  it('should detect speech segments when wrists have vertical advantage and motion energy exceeds lambda', () => {
    const frames: FramePoseLandmarks[] = [];
    const framerate = 5;
    const totalFrames = 40;

    for (let i = 0; i < totalFrames; i++) {
      if (i >= 10 && i < 30) {
        // Active motion: wrists higher than elbows (wristY 0.2 < elbowY 0.5) with oscillating wristX
        const wristX = 0.4 + 0.1 * Math.sin(i);
        frames.push(createFullFrame(0.2, 0.5, wristX));
      } else {
        // Rest: wrists lower than elbows (wristY 0.7 > elbowY 0.5)
        frames.push(createFullFrame(0.7, 0.5));
      }
    }

    const result = model.segment({
      landmarks: frames,
      framerate,
      duration: totalFrames / framerate,
      lambda: 0.5,
    });

    expect(result.segments.length).toBeGreaterThan(0);
    const seg = result.segments[0];
    expect(seg.startTime).toBeGreaterThanOrEqual(1.5);
    expect(seg.endTime).toBeLessThanOrEqual(6.5);
  });

  it('should eliminate tiny segments smaller than minRegionLength', () => {
    const frames: FramePoseLandmarks[] = [];
    const framerate = 5;
    const totalFrames = 25;

    for (let i = 0; i < totalFrames; i++) {
      // 1 frame of active motion generates 5 active frames through the 1-second energy window
      if (i === 10) {
        frames.push(createFullFrame(0.1, 0.6, 0.2));
      } else {
        frames.push(createFullFrame(0.8, 0.5));
      }
    }

    const result = model.segment({
      landmarks: frames,
      framerate,
      duration: totalFrames / framerate,
      lambda: 0.5,
      minRegionLength: 8,
    });

    // 5 active frames resulting from a single impulse are smaller than minRegionLength=8 and merged into rest
    expect(result.segments.length).toBe(0);
  });

  it('should interpolate single missing frames via continuity filling', () => {
    const frames: FramePoseLandmarks[] = [];
    const framerate = 5;
    const totalFrames = 25;

    for (let i = 0; i < totalFrames; i++) {
      if (i >= 5 && i <= 20) {
        if (i === 12) {
          // Single missing frame
          frames.push(null);
        } else {
          const wristX = 0.35 + 0.15 * (i % 2);
          frames.push(createFullFrame(0.2, 0.6, wristX));
        }
      } else {
        frames.push(createFullFrame(0.8, 0.5));
      }
    }

    const result = model.segment({
      landmarks: frames,
      framerate,
      duration: totalFrames / framerate,
      lambda: 0.2,
    });

    // Continuity filling bridges the single missing frame so segmentation continues seamlessly
    expect(result.segments.length).toBe(1);
  });

  it('should expose lambda in model parameter definitions', () => {
    expect(model.parameters).toBeDefined();
    const lambdaDef = model.parameters?.find((p) => p.id === 'lambda');
    expect(lambdaDef).toBeDefined();
    expect(lambdaDef?.type).toBe('number');
    expect(lambdaDef?.min).toBe(0.0);
    expect(lambdaDef?.max).toBe(2.0);
  });

  it('should estimate lambda parameter using Introselect with 3-way partitioning', () => {
    const frames: FramePoseLandmarks[] = [];
    const framerate = 5;
    const totalFrames = 50;

    for (let i = 0; i < totalFrames; i++) {
      if (i >= 15 && i < 35) {
        frames.push(createFullFrame(0.2, 0.5));
      } else {
        frames.push(createFullFrame(0.7, 0.5));
      }
    }

    const estimated = model.estimateParameters({
      landmarks: frames,
      framerate,
      duration: totalFrames / framerate,
    });

    expect(estimated.lambda).toBeDefined();
    expect(estimated.lambda).toBeGreaterThan(0.0);
    expect(estimated.lambda).toBeLessThanOrEqual(2.0);
  });

  it('should default to estimated lambda when segment is called without lambda', () => {
    const frames: FramePoseLandmarks[] = [];
    const framerate = 5;
    const totalFrames = 50;

    for (let i = 0; i < totalFrames; i++) {
      if (i >= 15 && i < 35) {
        frames.push(createFullFrame(0.2, 0.5));
      } else {
        frames.push(createFullFrame(0.7, 0.5));
      }
    }

    const result = model.segment({
      landmarks: frames,
      framerate,
      duration: totalFrames / framerate,
    });

    expect(result.segments.length).toBeGreaterThan(0);
  });
});

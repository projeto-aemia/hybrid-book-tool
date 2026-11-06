import {
  introselect,
  partition3Way,
  medianOf3,
  insertionSort,
  findQuantiles,
  findQuantile,
  findPercentile,
  estimateLambdaFromEnergy,
} from './introselect';

describe('Introselect with 3-Way Partitioning', () => {
  describe('insertionSort', () => {
    it('should sort a subarray in place', () => {
      const arr = [5, 2, 8, 1, 9, 3];
      insertionSort(arr, 1, 4);
      expect(arr).toEqual([5, 1, 2, 8, 9, 3]);
    });
  });

  describe('partition3Way', () => {
    it('should partition around pivot with duplicates correctly (Dutch National Flag)', () => {
      const arr = [3, 1, 2, 2, 0, 2, 4, 2, 1];
      const [lt, gt] = partition3Way(arr, 0, arr.length - 1, 2);

      expect(lt).toBeLessThanOrEqual(gt);

      // All elements before lt must be < 2
      for (let i = 0; i < lt; i++) {
        expect(arr[i]).toBeLessThan(2);
      }

      // All elements between lt and gt must be == 2
      for (let i = lt; i <= gt; i++) {
        expect(arr[i]).toBe(2);
      }

      // All elements after gt must be > 2
      for (let i = gt + 1; i < arr.length; i++) {
        expect(arr[i]).toBeGreaterThan(2);
      }
    });

    it('should handle array where all elements are identical to pivot', () => {
      const arr = [0, 0, 0, 0, 0];
      const [lt, gt] = partition3Way(arr, 0, arr.length - 1, 0);
      expect(lt).toBe(0);
      expect(gt).toBe(4);
      expect(arr).toEqual([0, 0, 0, 0, 0]);
    });
  });

  describe('medianOf3', () => {
    it('should return the median among left, mid, and right', () => {
      expect(medianOf3([10, 50, 30], 0, 2)).toBe(30);
      expect(medianOf3([30, 10, 50], 0, 2)).toBe(30);
      expect(medianOf3([50, 30, 10], 0, 2)).toBe(30);
      expect(medianOf3([10, 10, 20], 0, 2)).toBe(10);
    });
  });

  describe('introselect', () => {
    it('should throw RangeError on empty array', () => {
      expect(() => introselect([], 0)).toThrow(RangeError);
    });

    it('should throw RangeError when k is out of bounds', () => {
      expect(() => introselect([1, 2, 3], -1)).toThrow(RangeError);
      expect(() => introselect([1, 2, 3], 3)).toThrow(RangeError);
    });

    it('should return the only element for a single-element array', () => {
      const arr = [42];
      expect(introselect(arr, 0)).toBe(42);
    });

    it('should select correct elements on small arrays', () => {
      const arr = [7, 2, 5, 1, 9];
      expect(introselect(arr.slice(), 0)).toBe(1);
      expect(introselect(arr.slice(), 1)).toBe(2);
      expect(introselect(arr.slice(), 2)).toBe(5);
      expect(introselect(arr.slice(), 3)).toBe(7);
      expect(introselect(arr.slice(), 4)).toBe(9);
    });

    it('should handle large plateaus of identical values (such as zeros from rest postures)', () => {
      const arr = new Float32Array(500);

      // 300 zeros (60%), followed by positive numbers
      for (let i = 300; i < 500; i++) {
        arr[i] = i * 0.01;
      }

      // Shuffle slightly
      for (let i = 0; i < 500; i++) {
        const j = Math.floor(Math.random() * 500);
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }

      // Check ranks in the zero plateau
      expect(introselect(arr.slice(), 0)).toBe(0);
      expect(introselect(arr.slice(), 50)).toBe(0);
      expect(introselect(arr.slice(), 299)).toBe(0);

      // Check rank after the zero plateau
      const sorted = Array.from(arr).sort((a, b) => a - b);
      expect(introselect(arr.slice(), 350)).toBeCloseTo(sorted[350], 4);
    });

    it('should match full sort results across 100 random arrays', () => {
      for (let test = 0; test < 100; test++) {
        const n = 50 + Math.floor(Math.random() * 150);
        const data = Array.from({ length: n }, () => Math.random() * 10);
        const sorted = data.slice().sort((a, b) => a - b);
        const k = Math.floor(Math.random() * n);

        const result = introselect(data.slice(), k);
        expect(result).toBe(sorted[k]);
      }
    });
  });

  describe('findQuantiles, findQuantile, findPercentile', () => {
    it('should compute accurate quantiles on known uniform array', () => {
      const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(findQuantile(arr, 0.0)).toBe(0);
      expect(findQuantile(arr, 0.5)).toBe(5);
      expect(findQuantile(arr, 1.0)).toBe(10);
      expect(findPercentile(arr, 10)).toBe(1);
      expect(findPercentile(arr, 95)).toBe(10);
    });

    it('should compute multiple quantiles in order using findQuantiles', () => {
      const arr = [10, 80, 20, 90, 30, 40, 50, 70, 60];
      const quantiles = findQuantiles(arr, [0.1, 0.5, 0.9]);
      const sorted = arr.slice().sort((a, b) => a - b);

      expect(quantiles[0]).toBe(sorted[Math.round(0.1 * (arr.length - 1))]);
      expect(quantiles[1]).toBe(sorted[Math.round(0.5 * (arr.length - 1))]);
      expect(quantiles[2]).toBe(sorted[Math.round(0.9 * (arr.length - 1))]);
    });

    it('should handle empty or single-element inputs safely', () => {
      expect(findQuantiles([], [0.1, 0.5])).toEqual([0, 0]);
      expect(findQuantiles([7.5], [0.1, 0.95])).toEqual([7.5, 7.5]);
    });
  });

  describe('estimateLambdaFromEnergy', () => {
    it('should calculate lambda according to LAMBDA_HEURISTIC formula: P10 + 0.25 * (P95 - P10)', () => {
      // Create a distribution where P10 is 0.80 and P95 is 1.60
      // Expected: 0.80 + 0.25 * (1.60 - 0.80) = 0.80 + 0.20 = 1.00
      const energy = new Float32Array(101);
      for (let i = 0; i <= 100; i++) {
        // Linearly spaced from 0 to 2
        energy[i] = i / 50.0;
      }

      // P10 (index 10) = 0.20, P95 (index 95) = 1.90
      // 0.20 + 0.25 * (1.90 - 0.20) = 0.625
      // Let's test with values where P10 = 0.8 and P95 = 1.6
      const sample = [
        ...Array.from({ length: 10 }, () => 0.5),

        // Rank 10
        0.8,
        ...Array.from({ length: 84 }, () => 1.2),

        // Rank 95
        1.6,
        ...Array.from({ length: 5 }, () => 2.0),
      ];

      // 0.8 + 0.25 * (1.6 - 0.8) = 1.0
      const estimated = estimateLambdaFromEnergy(sample);
      expect(estimated).toBe(1.0);
    });

    it('should return 1.0 for empty input array', () => {
      expect(estimateLambdaFromEnergy([])).toBe(1.0);
    });

    it('should clamp minimum lambda to minLambda (0.01)', () => {
      const zeros = new Float32Array(50).fill(0);
      expect(estimateLambdaFromEnergy(zeros)).toBe(0.01);
    });

    it('should clamp maximum lambda to maxLambda (2.0)', () => {
      const highValues = new Float32Array(50).fill(10.0);
      expect(estimateLambdaFromEnergy(highValues)).toBe(2.0);
    });
  });
});

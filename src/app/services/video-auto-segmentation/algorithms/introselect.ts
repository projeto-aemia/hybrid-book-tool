/**
 * Introspective selection (Introselect) algorithm with Dutch National Flag 3-way partitioning.
 * Provides worst-case O(N) selection performance and handles plateau/duplicate values in O(1).
 */

/**
 * Swaps two elements in an array or typed array.
 *
 * @param arr The array containing the elements.
 * @param i Index of the first element.
 * @param j Index of the second element.
 */
function swap(arr: Float32Array | number[], i: number, j: number): void {
  const temp = arr[i];
  arr[i] = arr[j];
  arr[j] = temp;
}

/**
 * Sorts a small subarray using insertion sort.
 *
 * @param arr Target array to sort in place.
 * @param left Starting index of the subarray.
 * @param right Ending index of the subarray.
 */
export function insertionSort(arr: Float32Array | number[], left: number, right: number): void {
  for (let i = left + 1; i <= right; i++) {
    const key = arr[i];
    let j = i - 1;
    while (j >= left && arr[j] > key) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = key;
  }
}

/**
 * Partitions a subarray into three contiguous groups around a pivot value using the Dutch National Flag algorithm:
 * - Elements strictly less than pivot: `[left .. lt - 1]`
 * - Elements equal to pivot: `[lt .. gt]`
 * - Elements strictly greater than pivot: `[gt + 1 .. right]`
 *
 * @param arr Array to partition in place.
 * @param left Left bound of subarray.
 * @param right Right bound of subarray.
 * @param pivot Pivot value to compare against.
 * @returns Tuple `[lt, gt]` representing the range of elements equal to the pivot.
 */
export function partition3Way(
  arr: Float32Array | number[],
  left: number,
  right: number,
  pivot: number,
): [number, number] {
  let lt = left;
  let gt = right;
  let i = left;

  while (i <= gt) {
    const val = arr[i];
    if (val < pivot) {
      swap(arr, lt, i);
      lt++;
      i++;
    } else if (val > pivot) {
      swap(arr, gt, i);
      gt--;
    } else {
      i++;
    }
  }

  return [lt, gt];
}

/**
 * Selects the median value among first, middle, and last elements in a subarray range.
 *
 * @param arr Input array.
 * @param left Subarray start index.
 * @param right Subarray end index.
 * @returns Median value of arr[left], arr[mid], arr[right].
 */
export function medianOf3(arr: Float32Array | number[], left: number, right: number): number {
  const mid = left + Math.floor((right - left) / 2);
  const a = arr[left];
  const b = arr[mid];
  const c = arr[right];

  if ((a <= b && b <= c) || (c <= b && b <= a)) {
    return b;
  }
  if ((b <= a && a <= c) || (c <= a && a <= b)) {
    return a;
  }
  return c;
}

/**
 * Fallback pivot selector using Median-of-Medians (BFPRT) to guarantee worst-case O(N) selection.
 *
 * @param arr Input array to select pivot from.
 * @param left Left bound of the subarray.
 * @param right Right bound of the subarray.
 * @returns Pivot value chosen as the median of 5-element group medians.
 */
function medianOfMediansPivot(arr: Float32Array | number[], left: number, right: number): number {
  const n = right - left + 1;
  if (n <= 5) {
    insertionSort(arr, left, right);
    return arr[left + Math.floor(n / 2)];
  }

  let numMedians = 0;
  for (let i = left; i <= right; i += 5) {
    const subRight = Math.min(i + 4, right);
    insertionSort(arr, i, subRight);
    const medianIdx = i + Math.floor((subRight - i) / 2);
    swap(arr, left + numMedians, medianIdx);
    numMedians++;
  }

  const midOfMediansTarget = left + Math.floor(numMedians / 2);
  introselectSubarray(arr, left, left + numMedians - 1, midOfMediansTarget, 0);
  return arr[midOfMediansTarget];
}

/**
 * Recursive/iterative core of Introselect with 3-way partitioning.
 *
 * @param arr Array to partition and select in place.
 * @param left Subarray left index.
 * @param right Subarray right index.
 * @param k Target 0-based rank to find.
 * @param depthLimit Remaining allowed Quickselect recursion depth before triggering fallback.
 * @returns Element value at rank k.
 */
export function introselectSubarray(
  arr: Float32Array | number[],
  left: number,
  right: number,
  k: number,
  depthLimit: number,
): number {
  let curLeft = left;
  let curRight = right;
  let curDepth = depthLimit;

  while (curLeft <= curRight) {
    if (curLeft === curRight) {
      return arr[curLeft];
    }

    // Small subarray optimization
    if (curRight - curLeft <= 16) {
      insertionSort(arr, curLeft, curRight);
      return arr[k];
    }

    let pivot: number;
    if (curDepth <= 0) {
      pivot = medianOfMediansPivot(arr, curLeft, curRight);
    } else {
      pivot = medianOf3(arr, curLeft, curRight);
      curDepth--;
    }

    const [lt, gt] = partition3Way(arr, curLeft, curRight, pivot);

    if (k >= lt && k <= gt) {
      return arr[k];
    } else if (k < lt) {
      curRight = lt - 1;
    } else {
      curLeft = gt + 1;
    }
  }

  return arr[k];
}

/**
 * Finds the k-th smallest element in an array in O(N) worst-case time using Introselect with 3-way partitioning.
 *
 * @param arr Array to search (partially rearranged in place).
 * @param k 0-based target index (0 is minimum, arr.length - 1 is maximum).
 * @param left Optional start boundary (default 0).
 * @param right Optional end boundary (default arr.length - 1).
 * @returns The value of the k-th smallest element.
 * @throws {RangeError} If k is out of bounds [left, right].
 */
export function introselect(
  arr: Float32Array | number[],
  k: number,
  left = 0,
  right = arr.length - 1,
): number {
  if (arr.length === 0) {
    throw new RangeError('Cannot run introselect on an empty array.');
  }
  if (k < left || k > right) {
    throw new RangeError(`Target rank index ${k} is out of bounds [${left}, ${right}].`);
  }

  const depthLimit = 2 * Math.floor(Math.log2(Math.max(2, right - left + 1)));
  return introselectSubarray(arr, left, right, k, depthLimit);
}

/**
 * Computes multiple quantiles efficiently from an input array using successive subrange Introselect.
 *
 * @param data Input numerical series (not mutated).
 * @param quantiles Array of quantile values in range [0, 1].
 * @returns Array of quantile values matching the input quantile orders.
 */
export function findQuantiles(
  data: Float32Array | number[] | readonly number[],
  quantiles: readonly number[],
): number[] {
  const n = data.length;
  if (n === 0) {
    return quantiles.map(() => 0);
  }
  if (n === 1) {
    return quantiles.map(() => data[0]);
  }

  // Copy data to avoid mutating original time-series signal
  const working = new Float32Array(data);

  // Map each quantile to an integer target index k in [0, n - 1]
  const targets = quantiles.map((q, originalIndex) => {
    const clampedQ = Math.max(0, Math.min(1, q));
    const k = Math.round(clampedQ * (n - 1));
    return { originalIndex, k };
  });

  // Sort by target index k so we can select in increasing order
  targets.sort((a, b) => a.k - b.k);

  const results: number[] = new Array(quantiles.length);
  let subLeft = 0;

  for (const { originalIndex, k } of targets) {
    const val = introselect(working, k, subLeft, n - 1);
    results[originalIndex] = val;
    subLeft = k;
  }

  return results;
}

/**
 * Computes a single quantile from an input array using Introselect with 3-way partitioning.
 *
 * @param data Input numerical series (not mutated).
 * @param q Quantile value in range [0, 1].
 * @returns Value at empirical quantile q.
 */
export function findQuantile(
  data: Float32Array | number[] | readonly number[],
  q: number,
): number {
  return findQuantiles(data, [q])[0];
}

/**
 * Computes a percentile (0 to 100) from an input array using Introselect with 3-way partitioning.
 *
 * @param data Input numerical series (not mutated).
 * @param p Percentile value in range [0, 100].
 * @returns Value at empirical percentile p.
 */
export function findPercentile(
  data: Float32Array | number[] | readonly number[],
  p: number,
): number {
  return findQuantile(data, p / 100.0);
}

/**
 * Automatic lambda threshold estimation heuristic as formulated in LAMBDA_HEURISTIC.md:
 * - Resting energy floor: E_rest = Q(0.10) (10th percentile)
 * - Active energy ceiling: E_active = Q(0.95) (95th percentile)
 * - Dynamic range: Delta E = E_active - E_rest
 * - Estimated lambda: lambda_hat = E_rest + alpha * Delta E (with alpha = 0.25)
 *
 * @param shortTimeEnergy Array of short-time energy signal values.
 * @param minLambda Optional lower bound clamp (default 0.01).
 * @param maxLambda Optional upper bound clamp (default 2.0).
 * @returns Estimated lambda threshold rounded to two decimal places.
 */
export function estimateLambdaFromEnergy(
  shortTimeEnergy: Float32Array | number[] | readonly number[],
  minLambda = 0.01,
  maxLambda = 2.0,
): number {
  if (shortTimeEnergy.length === 0) {
    return 1.0;
  }

  const [eRest, eActive] = findQuantiles(shortTimeEnergy, [0.10, 0.95]);
  const deltaE = Math.max(0, eActive - eRest);
  const alpha = 0.25;
  const estimated = eRest + alpha * deltaE;

  const clamped = Math.max(minLambda, Math.min(maxLambda, estimated));
  return Number(clamped.toFixed(2));
}

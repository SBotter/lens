/**
 * Shared utilities for the sync layer.
 *
 * Single source of truth for:
 *   - haversine distance (used by SyncAnalyzer, IntensityScorer, CandidateDetector)
 *   - bisectLeft / bisectRight (binary search over sorted number arrays)
 */

// ── Haversine distance (meters) ───────────────────────────────────────────────

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R  = 6_371_000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const dφ = (lat2 - lat1) * Math.PI / 180;
  const dλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Binary search ─────────────────────────────────────────────────────────────
//
// bisectLeft:  returns index of leftmost position where val can be inserted
//              to keep arr sorted (i.e. arr[i-1] < val <= arr[i])
//
// bisectRight: returns index of rightmost position where val can be inserted
//              to keep arr sorted (i.e. arr[i-1] <= val < arr[i])
//
// Both operate on a sorted array of numbers.

export function bisectLeft(arr: number[], val: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < val) lo = mid + 1;
    else                hi = mid;
  }
  return lo;
}

export function bisectRight(arr: number[], val: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= val) lo = mid + 1;
    else                 hi = mid;
  }
  return lo;
}

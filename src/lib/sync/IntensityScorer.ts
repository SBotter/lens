/**
 * IntensityScorer — per-point activity intensity.
 *
 * Computes a composite intensity score [0–1] for each timeline point using
 * a profile-adaptive weighted sum of normalized sensor metrics, then smooths
 * with a rolling window to reduce GPS jitter noise.
 *
 * Profile detection:
 *   mean gradient > +4% → CLIMB
 *   mean gradient < -4% → DESCENT
 *   otherwise          → MIXED
 *
 * Output: Float32Array of scores per timeline point, plus sport profile.
 */

import type { ActivityJSON, TimelinePoint } from '../parser/types';
import type { IntensityWeights, RulesConfig } from './types';
import { haversine } from './_utils';

export type SportProfile = 'CLIMB' | 'DESCENT' | 'MIXED';

export interface IntensityResult {
  scores:       Float32Array;
  masterScore:  Float32Array;
  profile:      SportProfile;
  alpha:        number;
}

// ── Gradient computation (fraction) ──────────────────────────────────────────

function computeGradients(pts: TimelinePoint[]): Float32Array {
  const g = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const dist = haversine(
      pts[i - 1].position.lat, pts[i - 1].position.lon,
      pts[i].position.lat,     pts[i].position.lon,
    );
    if (dist < 0.5) { g[i] = g[i - 1]; continue; }
    g[i] = (pts[i].elevation - pts[i - 1].elevation) / dist;
  }
  return g;
}

// ── Min/max normalization ─────────────────────────────────────────────────────

function minMaxNorm(arr: Float32Array | number[], min: number, max: number): Float32Array {
  const range = max - min;
  const out   = new Float32Array(arr.length);
  if (range < 1e-9) return out;
  for (let i = 0; i < arr.length; i++) {
    out[i] = Math.min(1, Math.max(0, ((arr as number[])[i] - min) / range));
  }
  return out;
}

// ── Rolling average smoothing ─────────────────────────────────────────────────

function rollingAvg(arr: Float32Array, halfWin: number): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(arr.length - 1, i + halfWin);
    let sum  = 0;
    for (let j = lo; j <= hi; j++) sum += arr[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

// ── Eventfulness: local contrast ratio ───────────────────────────────────────

function computeEventfulness(scores: Float32Array, halfWin: number): Float32Array {
  const out = new Float32Array(scores.length);
  for (let i = 0; i < scores.length; i++) {
    const lo   = Math.max(0, i - halfWin);
    const hi   = Math.min(scores.length - 1, i + halfWin);
    let   mean = 0;
    for (let j = lo; j <= hi; j++) mean += scores[j];
    mean /= (hi - lo + 1);
    const ε = 1e-6;
    out[i] = Math.min(1, Math.max(0, (scores[i] - mean) / (mean + ε)));
  }
  return out;
}

// ── Sport profile detection ───────────────────────────────────────────────────

function detectProfile(gradients: Float32Array): SportProfile {
  let sum = 0;
  for (let i = 0; i < gradients.length; i++) sum += gradients[i];
  const mean = sum / gradients.length;
  if (mean > 0.04)  return 'CLIMB';
  if (mean < -0.04) return 'DESCENT';
  return 'MIXED';
}

// ── Main scoring ──────────────────────────────────────────────────────────────

export function computeIntensity(
  activity:   ActivityJSON,
  weightsCfg: RulesConfig['intensity'],
): IntensityResult {
  const pts = activity.activity.timeline;
  const n   = pts.length;

  if (n === 0) {
    return { scores: new Float32Array(0), masterScore: new Float32Array(0), profile: 'MIXED', alpha: 0.30 };
  }

  const gradients = computeGradients(pts);

  const hrArr    = new Float32Array(n);
  const speedArr = new Float32Array(n);
  const gradArr  = new Float32Array(n);
  const accelArr = new Float32Array(n);
  const powerArr = new Float32Array(n);

  let hrMin = Infinity, hrMax = -Infinity;
  let spMin = Infinity, spMax = -Infinity;
  let grMin = Infinity, grMax = -Infinity;
  let acMin = Infinity, acMax = -Infinity;
  let pwMin = Infinity, pwMax = -Infinity;

  for (let i = 0; i < n; i++) {
    const pt = pts[i];
    hrArr[i]    = pt.biometrics.heartRate  ?? 0;
    speedArr[i] = pt.movement.speed;
    gradArr[i]  = Math.abs(gradients[i]);
    accelArr[i] = Math.abs(pt.movement.acceleration);
    powerArr[i] = pt.biometrics.power ?? 0;

    if (hrArr[i]    > 0) { hrMin = Math.min(hrMin, hrArr[i]);    hrMax = Math.max(hrMax, hrArr[i]);    }
    if (speedArr[i] > 0) { spMin = Math.min(spMin, speedArr[i]); spMax = Math.max(spMax, speedArr[i]); }
    if (gradArr[i]  > 0) { grMin = Math.min(grMin, gradArr[i]);  grMax = Math.max(grMax, gradArr[i]);  }
    if (accelArr[i] > 0) { acMin = Math.min(acMin, accelArr[i]); acMax = Math.max(acMax, accelArr[i]); }
    if (powerArr[i] > 0) { pwMin = Math.min(pwMin, powerArr[i]); pwMax = Math.max(pwMax, powerArr[i]); }
  }

  const hrNorm = minMaxNorm(hrArr,    hrMin === Infinity ? 0 : hrMin, hrMax === -Infinity ? 1 : hrMax);
  const spNorm = minMaxNorm(speedArr, spMin === Infinity ? 0 : spMin, spMax === -Infinity ? 1 : spMax);
  const grNorm = minMaxNorm(gradArr,  grMin === Infinity ? 0 : grMin, grMax === -Infinity ? 1 : grMax);
  const acNorm = minMaxNorm(accelArr, acMin === Infinity ? 0 : acMin, acMax === -Infinity ? 1 : acMax);
  const pwNorm = minMaxNorm(powerArr, pwMin === Infinity ? 0 : pwMin, pwMax === -Infinity ? 1 : pwMax);

  const profile = detectProfile(gradients);
  const wKey    = profile.toLowerCase() as 'climb' | 'descent' | 'mixed';
  const w: IntensityWeights = weightsCfg.weights[wKey];
  const alpha   = profile === 'CLIMB' ? 0.35 : profile === 'DESCENT' ? 0.20 : 0.30;

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] =
      w.hr       * hrNorm[i]  +
      w.speed    * spNorm[i]  +
      w.gradient * grNorm[i]  +
      w.accel    * acNorm[i]  +
      w.power    * pwNorm[i];
  }

  const scores       = rollingAvg(raw, 5);
  const eventfulness = computeEventfulness(scores, 10);

  const masterScore = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    masterScore[i] = Math.min(1, Math.max(0, scores[i] * (alpha + (1 - alpha) * eventfulness[i])));
  }

  return { scores, masterScore, profile, alpha };
}

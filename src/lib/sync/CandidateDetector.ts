/**
 * CandidateDetector — highlight candidate detection.
 *
 * Applies the 6 scene rules (from RulesConfig.scenes) against the activity
 * timeline within a given coverage window, returning a ranked list of
 * HighlightCandidate objects ready for engine processing.
 *
 * All thresholds are driven by RulesConfig — no magic numbers in code.
 *
 * Scene types:
 *   CLIMB      — sustained high HR + positive gradient
 *   DESCENT    — sustained high speed + negative gradient
 *   SPRINT     — sudden speed acceleration
 *   TECHNICAL  — high accel at moderate speed (rough terrain, obstacles)
 *   SUFFER     — high HR at low speed (redline effort)
 *   FLOW       — climb immediately followed by descent (top of hill transition)
 */

import type { ActivityJSON, TimelinePoint } from '../parser/types';
import type { HighlightCandidate, SceneType, SceneZone, SceneConfidence, RulesConfig } from './types';
import type { IntensityResult } from './IntensityScorer';
import { haversine } from './_utils';

// ── Median interval between consecutive points (seconds) ─────────────────────
// Computed from the actual pts slice — never assumes a fixed sampling rate.
// Uses median (not mean) to be robust against GPS gaps and irregular recording.

function computeMedianInterval(pts: TimelinePoint[]): number {
  if (pts.length < 2) return 1;
  const intervals: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].timestamp - pts[i - 1].timestamp) / 1000;
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) return 1;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)];
}

// ── Percentile helper ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[idx];
}

function sortedValues(pts: TimelinePoint[], key: (p: TimelinePoint) => number | undefined): number[] {
  return pts
    .map(key)
    .filter((v): v is number => v !== undefined && v !== null && isFinite(v) && v > 0)
    .sort((a, b) => a - b);
}

// ── Gradient at point i (fraction) ───────────────────────────────────────────

function gradientAt(pts: TimelinePoint[], i: number): number {
  if (i === 0) return 0;
  const dist = haversine(
    pts[i - 1].position.lat, pts[i - 1].position.lon,
    pts[i].position.lat,     pts[i].position.lon,
  );
  if (dist < 0.5) return 0;
  return (pts[i].elevation - pts[i - 1].elevation) / dist;
}

// ── Zone classification ───────────────────────────────────────────────────────

function classifyZone(
  startMs:    number,
  endMs:      number,
  vidStartMs: number,
  vidEndMs:   number,
  marginMs:   number,
): SceneZone {
  const overlaps = startMs <= vidEndMs && endMs >= vidStartMs;
  if (overlaps) return 'INSIDE';
  const nearest = startMs > vidEndMs ? startMs - vidEndMs : vidStartMs - endMs;
  return nearest <= marginMs ? 'NEAR' : 'FAR';
}

// ── Confidence from score ─────────────────────────────────────────────────────

function scoreToConfidence(score: number): SceneConfidence {
  if (score >= 0.70) return 'HIGH';
  if (score >= 0.40) return 'MEDIUM';
  return 'LOW';
}

// ── Zone multiplier ───────────────────────────────────────────────────────────

function zoneMultiplier(zone: SceneZone, cfg: RulesConfig['candidateSelection']): number {
  return cfg.zoneMultipliers[zone.toLowerCase() as 'inside' | 'near' | 'far'];
}

// ── Greedy deduplication ──────────────────────────────────────────────────────

function selectTopN(
  candidates: HighlightCandidate[],
  maxPerType: number,
  minGapMs:   number,
): HighlightCandidate[] {
  const byType = new Map<SceneType, HighlightCandidate[]>();
  for (const c of candidates) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c);
  }

  const selected: HighlightCandidate[] = [];
  for (const typeCandidates of byType.values()) {
    const sorted = [...typeCandidates].sort((a, b) => b.score - a.score);
    let count = 0;
    for (const c of sorted) {
      if (count >= maxPerType) break;
      const tooClose = selected.some(s =>
        s.type === c.type &&
        Math.abs(s.activityStartMs - c.activityStartMs) < minGapMs,
      );
      if (!tooClose) { selected.push(c); count++; }
    }
  }
  return selected;
}

// ── Video seek position from activity timestamp ───────────────────────────────
//
// activity_time = video_time − offsetMs
// → video_time = activity_time + offsetMs
// → seek_sec   = (video_time − videoStartUtcMs) / 1000
//
// Clamped to [gpsLockSec, videoDuration].

function activityMsToVideoSec(
  activityMs:      number,
  offsetMs:        number,
  lockOffsetMs:    number,
  videoStartUtcMs: number,
  videoDuration:   number,
): number {
  const videoTimeMs = activityMs + offsetMs;
  const seekSec     = (videoTimeMs - videoStartUtcMs) / 1000;
  const lockSec     = lockOffsetMs / 1000;
  return Math.min(videoDuration, Math.max(lockSec, Math.max(0, seekSec)));
}

// ── Scene detectors ───────────────────────────────────────────────────────────

function detectClimb(
  pts:             TimelinePoint[],
  masterScore:     Float32Array,
  hrNorm:          Float32Array,
  vidStartMs:      number,
  vidEndMs:        number,
  medianInterval:  number,
  offsetMs:        number,
  lockOffsetMs:    number,
  videoStartUtcMs: number,
  videoDuration:   number,
  cfg:             RulesConfig,
): HighlightCandidate[] {
  const r  = cfg.scenes.climb;
  const cs = cfg.candidateSelection;
  const hr = sortedValues(pts, p => p.biometrics.heartRate);
  if (hr.length < pts.length * 0.10) return [];

  const windowPts = Math.max(1, Math.round(r.windowSec / medianInterval));
  const results: HighlightCandidate[] = [];

  for (let i = windowPts; i < pts.length; i++) {
    let passing = 0, maxHR = 0, sumGrad = 0;
    for (let j = i - windowPts; j <= i; j++) {
      const hrOk   = hrNorm[j] >= r.hrNormThreshold;
      const gradOk = gradientAt(pts, j) * 100 >= r.gradientPct;
      if (hrOk && gradOk) passing++;
      maxHR   = Math.max(maxHR, pts[j].biometrics.heartRate ?? 0);
      sumGrad += gradientAt(pts, j) * 100;
    }
    if (passing / (windowPts + 1) < r.coveragePct) continue;

    const startMs  = pts[i - windowPts].timestamp;
    const endMs    = pts[i].timestamp;
    const avgScore = masterScore.slice(i - windowPts, i + 1).reduce((s, v) => s + v, 0) / (windowPts + 1);
    const zone     = classifyZone(startMs, endMs, vidStartMs, vidEndMs, cs.videoMarginMs);

    results.push({
      id:              `CLIMB_${i}`,
      type:            'CLIMB',
      videoId:         '',
      activityStartMs: startMs,
      activityEndMs:   endMs,
      videoStartSec:   activityMsToVideoSec(startMs, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      videoEndSec:     activityMsToVideoSec(endMs,   offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      score:           avgScore * zoneMultiplier(zone, cs),
      confidence:      scoreToConfidence(avgScore),
      zone,
      label:           'BRUTAL CLIMB',
      metrics:         { maxHR, avgGradient: sumGrad / (windowPts + 1) },
      ruleIds:         ['scenes.climb'],
      sensorLimited:   false,
    });
  }
  return results;
}

function detectDescent(
  pts:             TimelinePoint[],
  masterScore:     Float32Array,
  spNorm:          Float32Array,
  vidStartMs:      number,
  vidEndMs:        number,
  medianInterval:  number,
  offsetMs:        number,
  lockOffsetMs:    number,
  videoStartUtcMs: number,
  videoDuration:   number,
  cfg:             RulesConfig,
): HighlightCandidate[] {
  const r  = cfg.scenes.descent;
  const cs = cfg.candidateSelection;
  const windowPts = Math.max(1, Math.round(r.windowSec / medianInterval));
  const results: HighlightCandidate[] = [];

  for (let i = windowPts; i < pts.length; i++) {
    let passing = 0, maxSpeed = 0, sumGrad = 0;
    for (let j = i - windowPts; j <= i; j++) {
      const spOk   = spNorm[j] >= r.speedNormThreshold;
      const gradOk = gradientAt(pts, j) * 100 <= r.gradientPct;
      if (spOk && gradOk) passing++;
      maxSpeed = Math.max(maxSpeed, pts[j].movement.speed * 3.6);
      sumGrad += gradientAt(pts, j) * 100;
    }
    if (passing / (windowPts + 1) < r.coveragePct) continue;

    const startMs  = pts[i - windowPts].timestamp;
    const endMs    = pts[i].timestamp;
    const avgScore = masterScore.slice(i - windowPts, i + 1).reduce((s, v) => s + v, 0) / (windowPts + 1);
    const zone     = classifyZone(startMs, endMs, vidStartMs, vidEndMs, cs.videoMarginMs);

    results.push({
      id:              `DESCENT_${i}`,
      type:            'DESCENT',
      videoId:         '',
      activityStartMs: startMs,
      activityEndMs:   endMs,
      videoStartSec:   activityMsToVideoSec(startMs, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      videoEndSec:     activityMsToVideoSec(endMs,   offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      score:           avgScore * zoneMultiplier(zone, cs),
      confidence:      scoreToConfidence(avgScore),
      zone,
      label:           'WILD DESCENT',
      metrics:         { maxSpeed, avgGradient: sumGrad / (windowPts + 1) },
      ruleIds:         ['scenes.descent'],
      sensorLimited:   false,
    });
  }
  return results;
}

function detectSprint(
  pts:             TimelinePoint[],
  masterScore:     Float32Array,
  vidStartMs:      number,
  vidEndMs:        number,
  medianInterval:  number,
  offsetMs:        number,
  lockOffsetMs:    number,
  videoStartUtcMs: number,
  videoDuration:   number,
  cfg:             RulesConfig,
): HighlightCandidate[] {
  const r  = cfg.scenes.sprint;
  const cs = cfg.candidateSelection;
  const windowPts = Math.max(1, Math.round(r.windowSec / medianInterval));
  const speeds    = pts.map(p => p.movement.speed);
  const maxSpeed  = Math.max(...speeds);
  const threshold = maxSpeed * r.speedDeltaFraction;
  const results: HighlightCandidate[] = [];

  for (let i = windowPts; i < pts.length; i++) {
    const delta = pts[i].movement.speed - pts[i - windowPts].movement.speed;
    if (delta < threshold) continue;

    const startMs  = pts[i - windowPts].timestamp;
    const endMs    = pts[i].timestamp;
    const avgScore = masterScore.slice(i - windowPts, i + 1).reduce((s, v) => s + v, 0) / (windowPts + 1);
    const zone     = classifyZone(startMs, endMs, vidStartMs, vidEndMs, cs.videoMarginMs);

    results.push({
      id:              `SPRINT_${i}`,
      type:            'SPRINT',
      videoId:         '',
      activityStartMs: startMs,
      activityEndMs:   endMs,
      videoStartSec:   activityMsToVideoSec(startMs, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      videoEndSec:     activityMsToVideoSec(endMs,   offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      score:           avgScore * zoneMultiplier(zone, cs),
      confidence:      scoreToConfidence(avgScore),
      zone,
      label:           'SPRINT',
      metrics:         { speedDeltaKmh: delta * 3.6, maxSpeedKmh: maxSpeed * 3.6 },
      ruleIds:         ['scenes.sprint'],
      sensorLimited:   false,
    });
  }
  return results;
}

function detectTechnical(
  pts:             TimelinePoint[],
  masterScore:     Float32Array,
  accelNorm:       Float32Array,
  spNorm:          Float32Array,
  vidStartMs:      number,
  vidEndMs:        number,
  medianInterval:  number,
  offsetMs:        number,
  lockOffsetMs:    number,
  videoStartUtcMs: number,
  videoDuration:   number,
  cfg:             RulesConfig,
): HighlightCandidate[] {
  const r  = cfg.scenes.technical;
  const cs = cfg.candidateSelection;
  const windowPts = Math.max(1, Math.round(r.windowSec / medianInterval));
  const results: HighlightCandidate[] = [];

  for (let i = windowPts; i < pts.length; i++) {
    let passing = 0, maxAccel = 0;
    for (let j = i - windowPts; j <= i; j++) {
      const accelOk = accelNorm[j] >= r.accelNormThreshold;
      const speedOk = spNorm[j] >= r.minSpeedNorm && spNorm[j] <= r.maxSpeedNorm;
      if (accelOk && speedOk) passing++;
      maxAccel = Math.max(maxAccel, pts[j].movement.acceleration);
    }
    if (passing / (windowPts + 1) < r.coveragePct) continue;

    const startMs  = pts[i - windowPts].timestamp;
    const endMs    = pts[i].timestamp;
    const avgScore = masterScore.slice(i - windowPts, i + 1).reduce((s, v) => s + v, 0) / (windowPts + 1);
    const zone     = classifyZone(startMs, endMs, vidStartMs, vidEndMs, cs.videoMarginMs);

    results.push({
      id:              `TECHNICAL_${i}`,
      type:            'TECHNICAL',
      videoId:         '',
      activityStartMs: startMs,
      activityEndMs:   endMs,
      videoStartSec:   activityMsToVideoSec(startMs, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      videoEndSec:     activityMsToVideoSec(endMs,   offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      score:           avgScore * zoneMultiplier(zone, cs),
      confidence:      scoreToConfidence(avgScore),
      zone,
      label:           'TECHNICAL TERRAIN',
      metrics:         { maxAccelMs2: maxAccel },
      ruleIds:         ['scenes.technical'],
      sensorLimited:   false,
    });
  }
  return results;
}

function detectSuffer(
  pts:             TimelinePoint[],
  masterScore:     Float32Array,
  hrNorm:          Float32Array,
  spNorm:          Float32Array,
  vidStartMs:      number,
  vidEndMs:        number,
  medianInterval:  number,
  offsetMs:        number,
  lockOffsetMs:    number,
  videoStartUtcMs: number,
  videoDuration:   number,
  cfg:             RulesConfig,
): HighlightCandidate[] {
  const r  = cfg.scenes.suffer;
  const cs = cfg.candidateSelection;
  const hrCoverage = pts.filter(p => p.biometrics.heartRate != null).length / pts.length;
  if (hrCoverage < 0.50) return [];

  const windowPts = Math.max(1, Math.round(r.windowSec / medianInterval));
  const results: HighlightCandidate[] = [];

  for (let i = windowPts; i < pts.length; i++) {
    let passing = 0, sumHR = 0, maxHR = 0;
    for (let j = i - windowPts; j <= i; j++) {
      const hrOk = hrNorm[j] >= r.hrNormThreshold;
      const spOk = spNorm[j] <= r.maxSpeedNorm;
      if (hrOk && spOk) passing++;
      const hr = pts[j].biometrics.heartRate ?? 0;
      sumHR += hr;
      maxHR = Math.max(maxHR, hr);
    }
    if (passing / (windowPts + 1) < r.coveragePct) continue;

    const startMs  = pts[i - windowPts].timestamp;
    const endMs    = pts[i].timestamp;
    const avgScore = masterScore.slice(i - windowPts, i + 1).reduce((s, v) => s + v, 0) / (windowPts + 1);
    const zone     = classifyZone(startMs, endMs, vidStartMs, vidEndMs, cs.videoMarginMs);

    results.push({
      id:              `SUFFER_${i}`,
      type:            'SUFFER',
      videoId:         '',
      activityStartMs: startMs,
      activityEndMs:   endMs,
      videoStartSec:   activityMsToVideoSec(startMs, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      videoEndSec:     activityMsToVideoSec(endMs,   offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
      score:           avgScore * zoneMultiplier(zone, cs),
      confidence:      scoreToConfidence(avgScore),
      zone,
      label:           'RED ZONE',
      metrics:         { avgHR: sumHR / (windowPts + 1), maxHR },
      ruleIds:         ['scenes.suffer'],
      sensorLimited:   false,
    });
  }
  return results;
}

// ── FLOW: post-processing over CLIMB + DESCENT candidates ─────────────────────
// Finds a CLIMB immediately followed (within maxGapSec) by a DESCENT.

function detectFlow(
  climbs:          HighlightCandidate[],
  descents:        HighlightCandidate[],
  pts:             TimelinePoint[],
  masterScore:     Float32Array,
  vidStartMs:      number,
  vidEndMs:        number,
  medianInterval:  number,   // unused here but part of sharedArgs — kept for consistency
  offsetMs:        number,
  lockOffsetMs:    number,
  videoStartUtcMs: number,
  videoDuration:   number,
  cfg:             RulesConfig,
): HighlightCandidate[] {
  const r        = cfg.scenes.flow;
  const cs       = cfg.candidateSelection;
  const maxGapMs = r.maxGapSec * 1000;
  const results: HighlightCandidate[] = [];

  for (const climb of climbs) {
    // Gradient check for the climb segment
    const climbPts = pts.filter(p => p.timestamp >= climb.activityStartMs && p.timestamp <= climb.activityEndMs);
    const avgClimbGrad = climbPts.length > 0
      ? climbPts.reduce((s, _, i) => s + gradientAt(climbPts, i) * 100, 0) / climbPts.length
      : 0;
    if (avgClimbGrad < r.minClimbGradient) continue;

    for (const descent of descents) {
      const gapMs = descent.activityStartMs - climb.activityEndMs;
      if (gapMs < 0 || gapMs > maxGapMs) continue;

      const descentPts = pts.filter(p => p.timestamp >= descent.activityStartMs && p.timestamp <= descent.activityEndMs);
      const avgDescentGrad = descentPts.length > 0
        ? descentPts.reduce((s, _, i) => s + gradientAt(descentPts, i) * 100, 0) / descentPts.length
        : 0;
      if (avgDescentGrad > r.minDescentGradient) continue;

      const startMs = climb.activityStartMs;
      const endMs   = descent.activityEndMs;

      // Compute avg master score over the full range
      const startIdx = pts.findIndex(p => p.timestamp >= startMs);
      const endIdx   = pts.findLastIndex(p => p.timestamp <= endMs);
      const avgScore = startIdx >= 0 && endIdx > startIdx
        ? masterScore.slice(startIdx, endIdx + 1).reduce((s, v) => s + v, 0) / (endIdx - startIdx + 1)
        : Math.max(climb.score, descent.score);

      const zone = classifyZone(startMs, endMs, vidStartMs, vidEndMs, cs.videoMarginMs);

      results.push({
        id:              `FLOW_${results.length}`,
        type:            'FLOW',
        videoId:         '',
        activityStartMs: startMs,
        activityEndMs:   endMs,
        videoStartSec:   activityMsToVideoSec(startMs, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
        videoEndSec:     activityMsToVideoSec(endMs,   offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration),
        score:           avgScore * zoneMultiplier(zone, cs),
        confidence:      scoreToConfidence(avgScore),
        zone,
        label:           'FLOW',
        metrics:         { avgClimbGradient: avgClimbGrad, avgDescentGradient: avgDescentGrad, gapSec: gapMs / 1000 },
        ruleIds:         ['scenes.flow'],
        sensorLimited:   false,
      });
    }
  }
  return results;
}

// ── Main detection entry point ────────────────────────────────────────────────

export interface DetectionContext {
  activity:        ActivityJSON;
  intensity:       IntensityResult;
  coverageStartMs: number;
  coverageEndMs:   number;
  videoStartMs:    number;
  videoEndMs:      number;
  offsetMs:        number;
  lockOffsetMs:    number;
  videoStartUtcMs: number;
  videoDuration:   number;
  videoId:         string;
}

export function detectCandidates(ctx: DetectionContext, cfg: RulesConfig): HighlightCandidate[] {
  const allPts = ctx.activity.activity.timeline;

  const startIdx = allPts.findIndex(p => p.timestamp >= ctx.coverageStartMs);
  const endIdx   = allPts.findLastIndex(p => p.timestamp <= ctx.coverageEndMs);
  if (startIdx < 0 || endIdx <= startIdx) return [];

  const pts         = allPts.slice(startIdx, endIdx + 1);
  const masterSlice = ctx.intensity.masterScore.slice(startIdx, endIdx + 1);

  // Percentile-based normalization for this window (robust against outliers)
  const hrValues    = sortedValues(pts, p => p.biometrics.heartRate);
  const spValues    = sortedValues(pts, p => p.movement.speed);
  const acValues    = sortedValues(pts, p => Math.abs(p.movement.acceleration));

  const hrMax  = percentile(hrValues, 0.95) || 1;
  const hrMin  = percentile(hrValues, 0.05) || 0;
  const spMax  = percentile(spValues, 0.95) || 1;
  const spMin  = percentile(spValues, 0.05) || 0;
  const acMax  = percentile(acValues, 0.95) || 1;
  const acMin  = percentile(acValues, 0.05) || 0;

  const hrNorm    = new Float32Array(pts.length);
  const spNorm    = new Float32Array(pts.length);
  const accelNorm = new Float32Array(pts.length);

  for (let i = 0; i < pts.length; i++) {
    hrNorm[i]    = hrMax > hrMin ? Math.min(1, Math.max(0, ((pts[i].biometrics.heartRate ?? 0) - hrMin) / (hrMax - hrMin))) : 0;
    spNorm[i]    = spMax > spMin ? Math.min(1, Math.max(0, (pts[i].movement.speed - spMin) / (spMax - spMin))) : 0;
    accelNorm[i] = acMax > acMin ? Math.min(1, Math.max(0, (Math.abs(pts[i].movement.acceleration) - acMin) / (acMax - acMin))) : 0;
  }

  const { videoStartMs, videoEndMs, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration } = ctx;

  // Compute sampling rate from the actual pts slice — never assume a fixed rate.
  // GoPro GPMF ≈ 18 Hz, FIT ≈ 1 Hz, GPX varies, TCX varies.
  const medianInterval = computeMedianInterval(pts);
  const sharedArgs = [medianInterval, offsetMs, lockOffsetMs, videoStartUtcMs, videoDuration, cfg] as const;

  const climbs    = detectClimb(    pts, masterSlice, hrNorm,              videoStartMs, videoEndMs, ...sharedArgs);
  const descents  = detectDescent(  pts, masterSlice, spNorm,              videoStartMs, videoEndMs, ...sharedArgs);
  const sprints   = detectSprint(   pts, masterSlice,                      videoStartMs, videoEndMs, ...sharedArgs);
  const technical = detectTechnical(pts, masterSlice, accelNorm, spNorm,   videoStartMs, videoEndMs, ...sharedArgs);
  const suffers   = detectSuffer(   pts, masterSlice, hrNorm, spNorm,      videoStartMs, videoEndMs, ...sharedArgs);
  const flows     = detectFlow(climbs, descents, pts, masterSlice,          videoStartMs, videoEndMs, ...sharedArgs);

  const all: HighlightCandidate[] = [...climbs, ...descents, ...sprints, ...technical, ...suffers, ...flows];

  for (const c of all) c.videoId = ctx.videoId;

  const selected = selectTopN(all, cfg.candidateSelection.maxPerType, cfg.candidateSelection.minGapMs);

  const typeCode: Record<SceneType, string> = {
    CLIMB: 'C1', DESCENT: 'C2', SPRINT: 'C3', TECHNICAL: 'C4', SUFFER: 'C5', FLOW: 'C6',
  };
  const typeCount: Partial<Record<SceneType, number>> = {};
  for (const c of selected) {
    const n = typeCount[c.type] ?? 0;
    c.id = `${typeCode[c.type]}_${n}`;
    typeCount[c.type] = n + 1;
  }

  return selected.sort((a, b) => b.score - a.score);
}

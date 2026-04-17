/**
 * SyncAnalyzer — per-video synchronization.
 *
 * Determines the clock offset between a video file and the activity GPS timestamps
 * using three strategies in priority order:
 *
 *   1. GPS Position Cross-Correlation (GoPro with GPS lock)
 *      Histogram voting over matched GPS point pairs. Industry standard approach.
 *
 *   2. Speed NCC — Normalized Cross-Correlation of speed profiles
 *      Fallback when GPS tracks don't spatially overlap or video has no GPS.
 *
 *   3. EXIF Timestamp
 *      Mobile devices (iPhone, Samsung) — assumes NTP-synced device clock.
 *
 * After offset is found, detects linear clock drift via residual regression.
 *
 * isOverlayUsable: per-method threshold (not a single score cutoff).
 *   gps-position  : confidence >= 0.60  (GPS UTC clocks are inherently accurate)
 *   speed-ncc     : confidence >= 0.70  (NCC can produce false peaks)
 *   exif-timestamp: clockConfidence >= 0.85  (NTP-synced device clock only)
 */

import type { ActivityJSON, VideoJSON, TimelinePoint, VideoTimelinePoint } from '../parser/types';
import type { VideoSyncResult, SyncMethod, VideoMeta } from './types';
import type { RulesConfig } from './types';
import { haversine, bisectLeft, bisectRight } from './_utils';

// ── isOverlayUsable — per-method reliability check ───────────────────────────

export function isOverlayUsable(params: {
  method:          SyncMethod;
  confidence:      number;
  clockConfidence: number;
}): boolean {
  switch (params.method) {
    case 'gps-position':   return params.confidence    >= 0.60;
    case 'speed-ncc':      return params.confidence    >= 0.70;
    case 'exif-timestamp': return params.clockConfidence >= 0.85;
    default:               return false;
  }
}

// ── Speed enrichment — compute m/s from consecutive positions if missing ──────

function enrichSpeed(points: { timestamp: number; lat: number; lon: number; speed: number }[]): void {
  for (let i = 1; i < points.length; i++) {
    if (points[i].speed > 0) continue;
    const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
    if (dt <= 0) continue;
    const d = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    points[i].speed = d / dt;
  }
}

// ── Resample a time-series to a fixed interval grid ───────────────────────────

function resample(
  points: { timestamp: number; speed: number }[],
  startMs: number,
  endMs:   number,
  stepMs:  number,
): number[] {
  const out: number[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) {
    let lo = 0;
    for (let i = 0; i < points.length - 1; i++) {
      if (points[i].timestamp <= t && points[i + 1].timestamp > t) { lo = i; break; }
    }
    const a = points[lo];
    const b = points[Math.min(lo + 1, points.length - 1)];
    const span = b.timestamp - a.timestamp;
    const frac = span > 0 ? (t - a.timestamp) / span : 0;
    out.push(a.speed + frac * (b.speed - a.speed));
  }
  return out;
}

// ── Smooth with a simple moving average ───────────────────────────────────────

function smooth(arr: number[], halfWin: number): number[] {
  return arr.map((_, i) => {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(arr.length - 1, i + halfWin);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += arr[j];
    return sum / (hi - lo + 1);
  });
}

// ── Z-score normalize ─────────────────────────────────────────────────────────

function zScore(arr: number[]): number[] {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const std  = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  if (std < 1e-9) return arr.map(() => 0);
  return arr.map(v => (v - mean) / std);
}

// ── Strategy 1: GPS Position Cross-Correlation ────────────────────────────────

function syncByGpsPosition(
  actPts:   TimelinePoint[],
  vidPts:   VideoTimelinePoint[],
  lockMs:   number,
  cfg:      RulesConfig['sync'],
): { offsetMs: number; confidence: number; syncQualityM: number } | null {
  const { spatialThresholdM, timeWindowMs, binMs, minVoteShare } = cfg;

  // Filter to post-lock, valid GPS video points
  const postLock = vidPts.filter(vp =>
    vp.fix >= 2 &&
    vp.timestamp >= (vidPts[0]?.timestamp ?? 0) + lockMs &&
    Math.abs(vp.position.lat) > 0.0001 &&
    Math.abs(vp.position.lon) > 0.0001,
  );
  if (postLock.length < 5) return null;

  // Pre-build sorted timestamps array for binary search — O(n) once
  const actTimestamps = actPts.map(p => p.timestamp);

  const deltas: number[] = [];
  const residualPairs: Array<{ delta: number; dist: number }> = [];

  for (const vp of postLock) {
    const windowStart = vp.timestamp - timeWindowMs;
    const windowEnd   = vp.timestamp + timeWindowMs;

    // Binary search replaces linear filter — O(log n) per video point
    const lo = bisectLeft(actTimestamps, windowStart);
    const hi = bisectRight(actTimestamps, windowEnd);

    for (let i = lo; i < hi; i++) {
      const ap   = actPts[i];
      const dist = haversine(vp.position.lat, vp.position.lon, ap.position.lat, ap.position.lon);
      if (dist < spatialThresholdM) {
        const delta = vp.timestamp - ap.timestamp;
        deltas.push(delta);
        residualPairs.push({ delta, dist });
      }
    }
  }

  if (deltas.length < 3) return null;

  // Histogram vote in bins of binMs
  const bins = new Map<number, number[]>();
  for (const d of deltas) {
    const bin = Math.round(d / binMs) * binMs;
    if (!bins.has(bin)) bins.set(bin, []);
    bins.get(bin)!.push(d);
  }

  let winnerBin: number[] = [];
  for (const vals of bins.values()) {
    if (vals.length > winnerBin.length) winnerBin = vals;
  }

  const voteShare = winnerBin.length / deltas.length;
  if (voteShare < minVoteShare) return null;

  const sorted    = [...winnerBin].sort((a, b) => a - b);
  const offsetMs  = sorted[Math.floor(sorted.length / 2)];
  const confidence = Math.min(1, voteShare / 0.30);

  const matched = residualPairs.filter(p => Math.abs(p.delta - offsetMs) < binMs);
  const syncQualityM = matched.length > 0
    ? matched.reduce((s, p) => s + p.dist, 0) / matched.length
    : spatialThresholdM;

  return { offsetMs, confidence, syncQualityM };
}

// ── Strategy 2: Speed NCC ─────────────────────────────────────────────────────

function syncBySpeedNCC(
  actPts: TimelinePoint[],
  vidPts: VideoTimelinePoint[],
  cfg:    RulesConfig['sync'],
): { offsetMs: number; confidence: number } | null {
  const { nccRangeMs, nccStepMs, nccMinConfidence, speedFilterKmh } = cfg;

  const aFlat = actPts.map(p => ({
    timestamp: p.timestamp,
    lat:       p.position.lat,
    lon:       p.position.lon,
    speed:     p.movement.speed,
  }));
  const vFlat = vidPts.map(p => ({
    timestamp: p.timestamp,
    lat:       p.position.lat,
    lon:       p.position.lon,
    speed:     p.movement.speed,
  }));

  enrichSpeed(aFlat);
  enrichSpeed(vFlat);

  const filterMs = speedFilterKmh / 3.6;
  const aMoving  = aFlat.filter(p => p.speed > filterMs);
  const vMoving  = vFlat.filter(p => p.speed > filterMs);
  if (aMoving.length < 10 || vMoving.length < 10) return null;

  const aStart = aMoving[0].timestamp;
  const aEnd   = aMoving[aMoving.length - 1].timestamp;
  const vStart = vMoving[0].timestamp;
  const vEnd   = vMoving[vMoving.length - 1].timestamp;

  const aResampled = resample(aMoving, aStart, aEnd, nccStepMs);
  const vResampled = resample(vMoving, vStart, vEnd, nccStepMs);

  const aSmooth = smooth(aResampled, 2);
  const vSmooth = smooth(vResampled, 2);

  const aNorm = zScore(aSmooth);
  const vNorm = zScore(vSmooth);

  const aEnergy = aNorm.reduce((s, v) => s + v * v, 0);
  const vEnergy = vNorm.reduce((s, v) => s + v * v, 0);
  if (aEnergy < 1e-6 || vEnergy < 1e-6) return null;

  const steps = Math.floor(nccRangeMs / nccStepMs);
  let bestOffset = 0;
  let bestScore  = -Infinity;
  const scores: number[] = [];

  for (let s = -steps; s <= steps; s++) {
    const offsetSamples = s;
    let dot = 0, normA = 0, normB = 0, count = 0;
    for (let i = 0; i < vNorm.length; i++) {
      const j = i - offsetSamples;
      if (j < 0 || j >= aNorm.length) continue;
      dot   += vNorm[i] * aNorm[j];
      normA += vNorm[i] * vNorm[i];
      normB += aNorm[j] * aNorm[j];
      count++;
    }
    if (count < 10 || normA < 1e-9 || normB < 1e-9) { scores.push(0); continue; }
    const ncc = dot / Math.sqrt(normA * normB);
    scores.push(ncc);
    if (ncc > bestScore) { bestScore = ncc; bestOffset = s * nccStepMs; }
  }

  const peakIdx = scores.indexOf(bestScore);
  const bg      = scores.filter((_, i) => Math.abs(i - peakIdx) > 3);
  if (bg.length < 5) return null;
  const bgMean = bg.reduce((s, v) => s + v, 0) / bg.length;
  const bgStd  = Math.sqrt(bg.reduce((s, v) => s + (v - bgMean) ** 2, 0) / bg.length);
  if (bgStd < 1e-9) return null;

  const confidence = Math.min(1, (bestScore - bgMean) / bgStd / 6);
  if (confidence < nccMinConfidence) return null;

  const offsetMs = vStart - aStart + bestOffset;
  return { offsetMs, confidence };
}

// ── Drift detection via linear regression on residuals ────────────────────────

function computeDrift(
  actPts:   TimelinePoint[],
  vidPts:   VideoTimelinePoint[],
  offsetMs: number,
  cfg:      RulesConfig['sync'],
): number {
  const pairs: Array<{ elapsed: number; residual: number }> = [];
  const videoStart     = vidPts[0]?.timestamp ?? 0;
  const actTimestamps  = actPts.map(p => p.timestamp);

  for (const vp of vidPts) {
    if (vp.fix < 2) continue;
    const correctedTime = vp.timestamp - offsetMs;

    // Binary search for nearest activity point
    const idx  = bisectLeft(actTimestamps, correctedTime);
    const best = actPts[idx] ?? actPts[actPts.length - 1];
    if (!best || Math.abs(best.timestamp - correctedTime) > 5000) continue;

    const dist = haversine(vp.position.lat, vp.position.lon, best.position.lat, best.position.lon);
    if (dist > cfg.spatialThresholdM * 2) continue;

    const elapsed  = (vp.timestamp - videoStart) / 1000;
    const residual = (vp.timestamp - offsetMs) - best.timestamp;
    pairs.push({ elapsed, residual });
  }

  if (pairs.length < 10) return 0;

  const n     = pairs.length;
  const sumX  = pairs.reduce((s, p) => s + p.elapsed, 0);
  const sumY  = pairs.reduce((s, p) => s + p.residual, 0);
  const sumXY = pairs.reduce((s, p) => s + p.elapsed * p.residual, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.elapsed * p.elapsed, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const ppm   = (slope * 1e6) / 1000;
  return isFinite(ppm) ? ppm : 0;
}

// ── Coverage window ───────────────────────────────────────────────────────────

function computeCoverage(
  actPts:   TimelinePoint[],
  vidPts:   VideoTimelinePoint[],
  offsetMs: number,
): { activityStartMs: number; activityEndMs: number; overlapFraction: number } {
  if (vidPts.length === 0 || actPts.length === 0) {
    return { activityStartMs: 0, activityEndMs: 0, overlapFraction: 0 };
  }

  const vidStartActivity = vidPts[0].timestamp                    - offsetMs;
  const vidEndActivity   = vidPts[vidPts.length - 1].timestamp    - offsetMs;
  const actStart         = actPts[0].timestamp;
  const actEnd           = actPts[actPts.length - 1].timestamp;

  const overlapStart    = Math.max(vidStartActivity, actStart);
  const overlapEnd      = Math.min(vidEndActivity,   actEnd);
  const overlapMs       = Math.max(0, overlapEnd - overlapStart);
  const actDuration     = actEnd - actStart;
  const overlapFraction = actDuration > 0 ? overlapMs / actDuration : 0;

  return {
    activityStartMs: Math.max(vidStartActivity, actStart),
    activityEndMs:   Math.min(vidEndActivity,   actEnd),
    overlapFraction: Math.min(1, overlapFraction),
  };
}

// ── VideoMeta extractor ───────────────────────────────────────────────────────

function toVideoMeta(video: VideoJSON): VideoMeta {
  const v = video.video;
  return {
    fileName:     v.metadata.fileName,
    device:       v.metadata.device,
    duration:     v.metadata.duration,
    fps:          v.metadata.fps,
    resolution:   v.metadata.resolution,
    creationTime: v.metadata.creationTime,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function analyzeSync(
  activity: ActivityJSON,
  video:    VideoJSON,
  cfg:      RulesConfig['sync'],
): VideoSyncResult {
  const actPts         = activity.activity.timeline;
  const vidPts         = video.video.timeline;
  const lockMs         = video.video.alignmentHints.gpsLockOffsetMs;
  const hasGps         = video.video.spatial.hasGps;
  const clockConfidence = video.video.time.clockConfidence;

  let offsetMs:     number     = 0;
  let confidence:   number     = 0;
  let method:       SyncMethod = 'exif-timestamp';
  let syncQualityM: number     = 0;
  let driftPpm:     number     = 0;

  if (hasGps && vidPts.length >= 5) {
    const gpsResult = syncByGpsPosition(actPts, vidPts, lockMs, cfg);
    if (gpsResult) {
      offsetMs     = gpsResult.offsetMs;
      confidence   = gpsResult.confidence;
      syncQualityM = gpsResult.syncQualityM;
      method       = 'gps-position';
      driftPpm     = computeDrift(actPts, vidPts, offsetMs, cfg);
    } else if (clockConfidence >= cfg.gpsUtcClockThreshold) {
      // GPS UTC identity: camera timestamps come from GPS satellite clock → offset ≈ 0.
      // Threshold is configurable so future vendors with different clockConfidence
      // values don't require code changes (default: 1.0 = GPS UTC only).
      offsetMs   = 0;
      confidence = 0.6;
      method     = 'gps-position';
    } else {
      const nccResult = syncBySpeedNCC(actPts, vidPts, cfg);
      if (nccResult) {
        offsetMs   = nccResult.offsetMs;
        confidence = nccResult.confidence * 0.75;
        method     = 'speed-ncc';
      } else {
        offsetMs   = 0;
        confidence = 0.3;
        method     = 'gps-position';
      }
    }
  } else {
    // Strategy 3: EXIF / container creation time
    offsetMs   = video.video.time.startTimeUtc - activity.activity.metadata.startTime;
    confidence = clockConfidence * 0.7;
    method     = 'exif-timestamp';
  }

  const coverage = computeCoverage(actPts, vidPts, offsetMs);

  return {
    source: toVideoMeta(video),
    sync: {
      offsetMs,
      driftPpm,
      confidence:      Math.min(1, Math.max(0, confidence)),
      method,
      clockConfidence,
      isOverlayUsable: isOverlayUsable({ method, confidence, clockConfidence }),
      gpsLockOffsetMs: lockMs,
      syncQualityM,
    },
    coverage,
  };
}

/**
 * SessionBuilder — assembles the final SessionJSON from all computed parts.
 *
 * Pipeline:
 *   1. Sync each video → VideoSyncResult (offset, drift, coverage, isOverlayUsable)
 *   2. Detect overlap between videos → auto-select winner (>15% score gap) or conflict
 *   3. Detect candidates within each video's coverage window
 *   4. Apply VIDEO_ONLY fallback if needed (VideoHighlightSelector)
 *   5. Cross-video deduplication + global top-N cap
 *   6. Derive renderMode + QualityReport
 *   7. Assemble SessionJSON
 */

import type { ActivityJSON, VideoJSON } from '../parser/types';
import type {
  SessionJSON, VideoSyncResult, HighlightCandidate, RulesConfig,
  ConflictRecord, QualityReport, RenderMode, VideoMeta, SyncMethod,
} from './types';
import { analyzeSync, isOverlayUsable } from './SyncAnalyzer';
import { computeIntensity }             from './IntensityScorer';
import { detectCandidates }             from './CandidateDetector';
import { selectVideoHighlights }        from './VideoHighlightSelector';

// ── renderMode derivation ─────────────────────────────────────────────────────

function computeDataRichness(activity: ActivityJSON): number {
  const pts = activity.activity.timeline;
  if (pts.length === 0) return 0;
  const hasHR      = pts.filter(p => p.biometrics.heartRate   != null).length / pts.length;
  const hasCadence = pts.filter(p => p.biometrics.cadence     != null).length / pts.length;
  const hasPower   = pts.filter(p => p.biometrics.power       != null).length / pts.length;
  // Speed and GPS are always present, so weight them as 1.0
  return (1.0 + 1.0 + hasHR + hasCadence + hasPower) / 5;
}

function deriveRenderMode(
  syncResult:   VideoSyncResult,
  activity:     ActivityJSON,
): RenderMode {
  const { isOverlayUsable: overlayOk } = syncResult.sync;
  const gpsQ        = activity.activity.quality.gpsQuality.signalConsistency;
  const dataRichness = computeDataRichness(activity);

  if (!overlayOk || gpsQ < 0.45)           return 'VIDEO_ONLY';
  if (gpsQ < 0.65)                          return 'MAP_ONLY';
  if (dataRichness < 0.40 || gpsQ < 0.85)  return 'PARTIAL_TELEMETRY';
  return 'FULL_TELEMETRY';
}

function buildQualityReport(
  syncResult:    VideoSyncResult,
  activity:      ActivityJSON,
  renderMode:    RenderMode,
): QualityReport {
  const { method, confidence, clockConfidence, isOverlayUsable: overlayOk } = syncResult.sync;
  const activityScore  = activity.activity.quality.overallScore;
  const dataRichness   = computeDataRichness(activity);
  const gpsQ           = activity.activity.quality.gpsQuality.signalConsistency;

  let userMessage    = 'Great data quality — full telemetry available.';
  let fallbackReason: string | undefined;

  if (renderMode === 'VIDEO_ONLY') {
    if (!overlayOk) {
      fallbackReason = `Sync confidence too low for telemetry overlay (method: ${method}, confidence: ${(confidence * 100).toFixed(0)}%)`;
      userMessage    = 'Sync quality was too low to overlay telemetry data. Video highlights were selected automatically.';
    } else {
      fallbackReason = `GPS quality insufficient for reliable overlay (GPS signal: ${(gpsQ * 100).toFixed(0)}%)`;
      userMessage    = 'GPS signal was too weak during video coverage. Video highlights were selected automatically.';
    }
  } else if (renderMode === 'MAP_ONLY') {
    fallbackReason = `GPS quality below overlay threshold (GPS signal: ${(gpsQ * 100).toFixed(0)}%)`;
    userMessage    = 'GPS quality allows map display but not precise telemetry overlay.';
  } else if (renderMode === 'PARTIAL_TELEMETRY') {
    fallbackReason = dataRichness < 0.40
      ? `Limited sensor data available (richness: ${(dataRichness * 100).toFixed(0)}%)`
      : `GPS signal slightly below optimal (GPS signal: ${(gpsQ * 100).toFixed(0)}%)`;
    userMessage = 'Some telemetry data is missing — partial overlay will be displayed.';
  }

  return {
    renderMode,
    syncMethod:      method,
    syncConfidence:  confidence,
    isOverlayUsable: overlayOk,
    activityScore,
    dataRichness,
    userMessage,
    fallbackReason,
  };
}

// ── Video overlap detection and resolution ────────────────────────────────────

function bestCandidateScore(
  videoFile:  string,
  candidates: HighlightCandidate[],
  startMs:    number,
  endMs:      number,
): number {
  const inRange = candidates.filter(c =>
    c.videoId === videoFile &&
    c.activityStartMs >= startMs &&
    c.activityEndMs   <= endMs,
  );
  if (inRange.length === 0) return 0;
  return Math.max(...inRange.map(c => c.score));
}

function resolveVideoOverlaps(
  syncResults: VideoSyncResult[],
  candidates:  HighlightCandidate[],
  cfg:         RulesConfig,
): ConflictRecord[] {
  const conflicts: ConflictRecord[] = [];
  const { overlapConflictThreshold, overlapTiebreakPct } = cfg.candidateSelection;

  for (let a = 0; a < syncResults.length; a++) {
    for (let b = a + 1; b < syncResults.length; b++) {
      const va = syncResults[a];
      const vb = syncResults[b];

      const overlapStart  = Math.max(va.coverage.activityStartMs, vb.coverage.activityStartMs);
      const overlapEnd    = Math.min(va.coverage.activityEndMs,   vb.coverage.activityEndMs);
      const overlapMs     = Math.max(0, overlapEnd - overlapStart);
      if (overlapMs === 0) continue;

      const aDuration = va.coverage.activityEndMs - va.coverage.activityStartMs;
      const bDuration = vb.coverage.activityEndMs - vb.coverage.activityStartMs;
      const shorter   = Math.min(aDuration, bDuration);
      if (shorter <= 0) continue;

      const overlapFraction = overlapMs / shorter;
      if (overlapFraction < overlapConflictThreshold) continue;

      // Overlap detected — try to auto-select by combined score × sync confidence
      const scoreA = bestCandidateScore(va.source.fileName, candidates, overlapStart, overlapEnd) * va.sync.confidence;
      const scoreB = bestCandidateScore(vb.source.fileName, candidates, overlapStart, overlapEnd) * vb.sync.confidence;
      const maxScore = Math.max(scoreA, scoreB);

      if (maxScore === 0) {
        // No candidates in range — just note the conflict without removing anything
        conflicts.push({
          type:            'video_overlap',
          activityStartMs: overlapStart,
          activityEndMs:   overlapEnd,
          videos:          [va.source, vb.source],
          reason:          'No scored candidates in overlap range — cannot auto-select',
        });
        continue;
      }

      const diff = Math.abs(scoreA - scoreB) / maxScore;

      if (diff > overlapTiebreakPct) {
        // Clear winner — remove candidates from loser in the overlap range
        const loserFile = scoreA >= scoreB ? vb.source.fileName : va.source.fileName;
        const toRemove  = candidates.filter(c =>
          c.videoId === loserFile &&
          c.activityStartMs >= overlapStart &&
          c.activityEndMs   <= overlapEnd,
        );
        for (const c of toRemove) {
          const idx = candidates.indexOf(c);
          if (idx >= 0) candidates.splice(idx, 1);
        }
      } else {
        // Ambiguous — remove from both and record conflict
        const toRemove = candidates.filter(c =>
          (c.videoId === va.source.fileName || c.videoId === vb.source.fileName) &&
          c.activityStartMs >= overlapStart &&
          c.activityEndMs   <= overlapEnd,
        );
        for (const c of toRemove) {
          const idx = candidates.indexOf(c);
          if (idx >= 0) candidates.splice(idx, 1);
        }
        conflicts.push({
          type:            'video_overlap',
          activityStartMs: overlapStart,
          activityEndMs:   overlapEnd,
          videos:          [va.source, vb.source],
          reason:          `Score difference ${(diff * 100).toFixed(1)}% is below ${(overlapTiebreakPct * 100).toFixed(0)}% threshold — cannot auto-select`,
        });
      }
    }
  }

  return conflicts;
}

// ── Fallback minimum candidates (when detectors find nothing) ─────────────────

function buildFallbackCandidates(
  activity:    ActivityJSON,
  syncResult:  VideoSyncResult,
  intensity:   ReturnType<typeof computeIntensity>,
  offsetMs:    number,
  videoMeta:   VideoMeta,
): HighlightCandidate[] {
  const pts      = activity.activity.timeline;
  const { activityStartMs, activityEndMs } = syncResult.coverage;

  const startIdx = pts.findIndex(p => p.timestamp >= activityStartMs);
  const endIdx   = pts.findLastIndex(p => p.timestamp <= activityEndMs);
  if (startIdx < 0 || endIdx <= startIdx) return [];

  const windowPts = pts.slice(startIdx, endIdx + 1);
  const scoreSlice = intensity.masterScore.slice(startIdx, endIdx + 1);

  // Divide into 3 equal segments, pick highest-scoring point per segment
  const segSize = Math.floor(windowPts.length / 3);
  if (segSize < 1) return [];

  const clipSec = 15;
  const results: HighlightCandidate[] = [];

  for (let s = 0; s < 3; s++) {
    const lo = s * segSize;
    const hi = Math.min((s + 1) * segSize - 1, windowPts.length - 1);
    let bestIdx = lo;
    for (let i = lo; i <= hi; i++) {
      if (scoreSlice[i] > scoreSlice[bestIdx]) bestIdx = i;
    }

    const center    = windowPts[bestIdx].timestamp;
    const startMs   = Math.max(activityStartMs, center - (clipSec / 2) * 1000);
    const endMs     = Math.min(activityEndMs,   center + (clipSec / 2) * 1000);
    const videoStartUtcMs = videoMeta.creationTime;
    const seekIn    = Math.max(0,                   (startMs + offsetMs - videoStartUtcMs) / 1000);
    const seekOut   = Math.min(videoMeta.duration,  (endMs   + offsetMs - videoStartUtcMs) / 1000);

    if (seekOut <= seekIn) continue;

    results.push({
      id:              `C6_${s}`,
      type:            'FLOW',
      videoId:         videoMeta.fileName,
      activityStartMs: startMs,
      activityEndMs:   endMs,
      videoStartSec:   seekIn,
      videoEndSec:     seekOut,
      score:           scoreSlice[bestIdx],
      confidence:      'LOW',
      zone:            'INSIDE',
      label:           'HIGHLIGHT',
      metrics:         {},
      ruleIds:         ['fallback.intensity-top'],
      sensorLimited:   true,
      sensorLimitedReason: 'No scene thresholds met — selected by peak intensity',
    });
  }
  return results;
}

// ── Cross-video candidate deduplication ──────────────────────────────────────

function deduplicateCandidates(candidates: HighlightCandidate[]): HighlightCandidate[] {
  const kept: HighlightCandidate[] = [];
  for (const c of candidates) {
    const overlap = kept.find(k => {
      const overlapStart = Math.max(k.activityStartMs, c.activityStartMs);
      const overlapEnd   = Math.min(k.activityEndMs,   c.activityEndMs);
      const overlapMs    = Math.max(0, overlapEnd - overlapStart);
      const shorterMs    = Math.min(
        k.activityEndMs - k.activityStartMs,
        c.activityEndMs - c.activityStartMs,
      );
      return shorterMs > 0 && overlapMs / shorterMs > 0.50;
    });
    if (!overlap) {
      kept.push(c);
    } else if (c.score > overlap.score) {
      kept.splice(kept.indexOf(overlap), 1, c);
    }
  }
  return kept;
}

// ── UUID ──────────────────────────────────────────────────────────────────────

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildSession(
  activity: ActivityJSON,
  videos:   VideoJSON[],
  rules:    RulesConfig,
): SessionJSON {
  const intensity = computeIntensity(activity, rules.intensity);

  // ── Per-video sync ──────────────────────────────────────────────────────────
  const syncResults: VideoSyncResult[] = videos.map(v => analyzeSync(activity, v, rules.sync));

  // ── Candidate detection ─────────────────────────────────────────────────────
  const allCandidates: HighlightCandidate[] = [];

  for (let i = 0; i < videos.length; i++) {
    const video      = videos[i];
    const syncResult = syncResults[i];
    const { offsetMs, gpsLockOffsetMs } = syncResult.sync;
    const { activityStartMs, activityEndMs } = syncResult.coverage;

    if (activityEndMs > activityStartMs) {
      const videoStartMs = video.video.time.startTimeUtc - offsetMs;
      const videoEndMs   = video.video.time.endTimeUtc   - offsetMs;

      const candidates = detectCandidates(
        {
          activity,
          intensity,
          coverageStartMs:  activityStartMs,
          coverageEndMs:    activityEndMs,
          videoStartMs,
          videoEndMs,
          offsetMs,
          lockOffsetMs:     gpsLockOffsetMs,
          videoStartUtcMs:  video.video.time.startTimeUtc,
          videoDuration:    video.video.metadata.duration,
          videoId:          video.video.metadata.fileName,
        },
        rules,
      );
      allCandidates.push(...candidates);
    }
  }

  // ── Video overlap resolution ────────────────────────────────────────────────
  const conflicts = resolveVideoOverlaps(syncResults, allCandidates, rules);

  // ── Fallback: if still no candidates, use intensity or video sensors ────────
  for (let i = 0; i < videos.length; i++) {
    const video      = videos[i];
    const syncResult = syncResults[i];
    const renderMode = deriveRenderMode(syncResult, activity);

    const hasCandidates = allCandidates.some(c => c.videoId === video.video.metadata.fileName);
    if (hasCandidates) continue;

    if (renderMode === 'VIDEO_ONLY') {
      // No usable activity data — use video's own sensors
      const videoCandidates = selectVideoHighlights(video);
      allCandidates.push(...videoCandidates);
    } else {
      // Activity data is usable but no scenes passed thresholds — use intensity fallback
      const fallback = buildFallbackCandidates(
        activity, syncResult, intensity, syncResult.sync.offsetMs, syncResult.source,
      );
      allCandidates.push(...fallback);
    }
  }

  // ── Dedup + global cap ──────────────────────────────────────────────────────
  const deduped = deduplicateCandidates(allCandidates)
    .sort((a, b) => b.score - a.score)
    .slice(0, rules.candidateSelection.maxCandidates);

  // ── Quality metrics ─────────────────────────────────────────────────────────
  const syncScore = syncResults.length > 0
    ? Math.min(...syncResults.map(v => v.sync.confidence))
    : 0;

  const actDuration = activity.activity.metadata.endTime - activity.activity.metadata.startTime;
  const coveredMs   = syncResults.reduce((s, v) =>
    s + (v.coverage.activityEndMs - v.coverage.activityStartMs), 0);
  const coverageScore = actDuration > 0 ? Math.min(1, coveredMs / actDuration) : 0;

  // Use first video's sync for the report (worst-case if multiple)
  const reportSync    = syncResults.reduce((worst, v) =>
    v.sync.confidence < worst.sync.confidence ? v : worst,
    syncResults[0] ?? { sync: { method: 'exif-timestamp' as const, confidence: 0, clockConfidence: 0, isOverlayUsable: false } } as VideoSyncResult,
  );
  const renderMode    = syncResults.length > 0 ? deriveRenderMode(reportSync, activity) : 'VIDEO_ONLY';
  const report        = syncResults.length > 0
    ? buildQualityReport(reportSync, activity, renderMode)
    : {
        renderMode:      'VIDEO_ONLY' as const,
        syncMethod:      'exif-timestamp' as const,
        syncConfidence:  0,
        isOverlayUsable: false,
        activityScore:   0,
        dataRichness:    0,
        userMessage:     'No video data available.',
      };

  return {
    session: {
      id:        uuid(),
      createdAt: Date.now(),
      activity,
      videos:    syncResults,
      candidates: deduped,
      conflicts,
      rules,
      quality: { syncScore, coverageScore, candidateCount: deduped.length },
      report,
    },
  };
}

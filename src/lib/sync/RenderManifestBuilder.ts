/**
 * RenderManifestBuilder — converts SessionJSON into a compact RenderManifest.
 *
 * SessionJSON is the full analysis artifact (~14 MB with activity + video data).
 * RenderManifest is the render engine's input — smaller, ordered narratively,
 * with per-second overlay data pre-computed and ready for use.
 *
 * Key design decisions:
 *   - Clips are sorted by activityStartMs (narrative order, not score order)
 *   - overlay is null when renderMode is VIDEO_ONLY or MAP_ONLY
 *   - overlay is 1 entry per second (engine interpolates at render time)
 *   - trackPath is decimated to max 500 points (every-Nth algorithm)
 *   - stats (peak/avg) are pre-computed per clip
 *   - playbackSpeed and transitions are derived from SceneType
 */

import type { ActivityJSON, TimelinePoint, VideoTimelinePoint } from '../parser/types';
import type {
  SessionJSON, RenderManifest, RenderClip, RenderFrame,
  HighlightCandidate, VideoSyncResult, TransitionType, RenderMode,
} from './types';
import { bisectLeft }        from './_utils';
import { computeIntensity }  from './IntensityScorer';

const RENDER_MANIFEST_VERSION = '1.0.0';
const MAX_TRACK_POINTS = 500;

// ── playbackSpeed by scene type ───────────────────────────────────────────────

function derivePlaybackSpeed(sceneType: HighlightCandidate['type']): number {
  switch (sceneType) {
    case 'DESCENT':   return 0.5;   // slow-mo — best visual impact
    case 'FLOW':      return 0.75;
    default:          return 1.0;
  }
}

// ── Transitions by scene type ─────────────────────────────────────────────────

function deriveTransitions(sceneType: HighlightCandidate['type']): {
  transitionIn:  TransitionType;
  transitionOut: TransitionType;
} {
  switch (sceneType) {
    case 'SPRINT':  return { transitionIn: 'speed-ramp-in', transitionOut: 'speed-ramp-out' };
    case 'DESCENT': return { transitionIn: 'dissolve',      transitionOut: 'dissolve' };
    default:        return { transitionIn: 'cut',           transitionOut: 'cut' };
  }
}

// ── Find nearest activity point by timestamp (binary search) ─────────────────

function nearestActivityPoint(
  pts:          TimelinePoint[],
  timestamps:   number[],
  targetMs:     number,
): TimelinePoint | null {
  if (pts.length === 0) return null;
  const idx  = bisectLeft(timestamps, targetMs);
  const cand = [pts[Math.max(0, idx - 1)], pts[Math.min(idx, pts.length - 1)]];
  return cand.reduce((best, p) =>
    Math.abs(p.timestamp - targetMs) < Math.abs(best.timestamp - targetMs) ? p : best,
  );
}

// ── Find nearest video telemetry point (for gForce / stability) ───────────────

function nearestVideoPoint(
  vidPts:     VideoTimelinePoint[],
  timestamps: number[],
  targetMs:   number,
): VideoTimelinePoint | null {
  if (vidPts.length === 0) return null;
  const idx  = bisectLeft(timestamps, targetMs);
  const cand = [vidPts[Math.max(0, idx - 1)], vidPts[Math.min(idx, vidPts.length - 1)]];
  return cand.reduce((best, p) =>
    Math.abs(p.timestamp - targetMs) < Math.abs(best.timestamp - targetMs) ? p : best,
  );
}

// ── Build per-second overlay for a clip ───────────────────────────────────────

function buildOverlay(
  candidate:       HighlightCandidate,
  actPts:          TimelinePoint[],
  actTimestamps:   number[],
  vidPts:          VideoTimelinePoint[],
  vidTimestamps:   number[],
  offsetMs:        number,
  seekIn:          number,
  videoStartUtcMs: number,
): RenderFrame[] {
  const overlay: RenderFrame[] = [];
  const durationSec = Math.ceil(candidate.activityEndMs - candidate.activityStartMs) / 1000;

  for (let s = 0; s <= durationSec; s++) {
    const activityMs = candidate.activityStartMs + s * 1000;
    const apt        = nearestActivityPoint(actPts, actTimestamps, activityMs);
    if (!apt) continue;

    // t = seconds from clip start
    const t = s;

    // Look up corresponding video telemetry point (for GoPro sensor data)
    const videoMs = activityMs + offsetMs;
    const vpt     = vidPts.length > 0 ? nearestVideoPoint(vidPts, vidTimestamps, videoMs) : null;

    // Cumulative distance from activity start (first point)
    const distFromStartM = actPts.length > 0
      ? (apt.movement?.distance != null
          ? (() => {
              // Sum distances up to this point
              const idx = bisectLeft(actTimestamps, activityMs);
              let sum = 0;
              for (let k = 0; k <= Math.min(idx, actPts.length - 1); k++) {
                sum += actPts[k].movement?.distance ?? 0;
              }
              return sum;
            })()
          : 0)
      : 0;

    overlay.push({
      t,
      speedKmh:       apt.movement.speed * 3.6,
      hr:             apt.biometrics.heartRate   ?? null,
      gradePct:       (apt.movement.grade ?? 0)  * 100,
      elevationM:     apt.elevation,
      distFromStartM,
      lat:            apt.position.lat,
      lon:            apt.position.lon,
      heading:        apt.direction.heading,
      intensity:      0,    // filled in below
      isMoving:       apt.derived.isMoving,
      stability:      vpt?.quality.stability   ?? null,
      gForce:         vpt?.sensors.gForce      ?? null,
    });
  }
  return overlay;
}

// ── Compute overlay intensity from activity masterScore ───────────────────────

function enrichOverlayIntensity(
  overlay:       RenderFrame[],
  candidate:     HighlightCandidate,
  actPts:        TimelinePoint[],
  actTimestamps: number[],
  masterScore:   Float32Array,
): void {
  for (const frame of overlay) {
    const activityMs = candidate.activityStartMs + frame.t * 1000;
    const idx        = bisectLeft(actTimestamps, activityMs);
    const clampedIdx = Math.min(idx, actPts.length - 1);
    frame.intensity  = masterScore[clampedIdx] ?? 0;
  }
}

// ── Compute clip stats (peak + avg) ───────────────────────────────────────────

function computeStats(overlay: RenderFrame[]): RenderClip['stats'] {
  if (overlay.length === 0) {
    return {
      peak: { speedKmh: 0, hr: null, gradePct: 0, gForce: null },
      avg:  { speedKmh: 0, hr: null, gradePct: 0, intensity: 0 },
    };
  }

  let peakSpeed = 0, peakHR: number | null = null, peakGrade = 0, peakGForce: number | null = null;
  let sumSpeed  = 0, sumHR  = 0, hrCount  = 0, sumGrade = 0, sumIntensity = 0;

  for (const f of overlay) {
    if (f.speedKmh > peakSpeed) peakSpeed = f.speedKmh;
    if (f.hr != null && (peakHR === null || f.hr > peakHR)) peakHR = f.hr;
    if (Math.abs(f.gradePct) > Math.abs(peakGrade)) peakGrade = f.gradePct;
    if (f.gForce != null && (peakGForce === null || f.gForce > peakGForce)) peakGForce = f.gForce;
    sumSpeed     += f.speedKmh;
    sumGrade     += f.gradePct;
    sumIntensity += f.intensity;
    if (f.hr != null) { sumHR += f.hr; hrCount++; }
  }

  const n = overlay.length;
  return {
    peak: { speedKmh: peakSpeed, hr: peakHR, gradePct: peakGrade, gForce: peakGForce },
    avg:  {
      speedKmh:  sumSpeed / n,
      hr:        hrCount > 0 ? sumHR / hrCount : null,
      gradePct:  sumGrade / n,
      intensity: sumIntensity / n,
    },
  };
}

// ── Track path decimation (every-Nth-point, max 500) ─────────────────────────

function buildTrackPath(actPts: TimelinePoint[]): RenderManifest['trackPath'] {
  if (actPts.length === 0) return [];
  const step = Math.max(1, Math.ceil(actPts.length / MAX_TRACK_POINTS));
  const out: RenderManifest['trackPath'] = [];
  for (let i = 0; i < actPts.length; i += step) {
    const p = actPts[i];
    out.push({ lat: p.position.lat, lon: p.position.lon, ele: p.elevation, t: p.t });
  }
  // Always include the last point for a complete track
  const last = actPts[actPts.length - 1];
  if (out[out.length - 1]?.t !== last.t) {
    out.push({ lat: last.position.lat, lon: last.position.lon, ele: last.elevation, t: last.t });
  }
  return out.slice(0, MAX_TRACK_POINTS);
}

// ── Cumulative distance at first point of a candidate ────────────────────────

function cumulativeDistAtMs(actPts: TimelinePoint[], actTimestamps: number[], targetMs: number): number {
  const idx = Math.min(bisectLeft(actTimestamps, targetMs), actPts.length - 1);
  let sum = 0;
  for (let i = 0; i <= idx; i++) sum += actPts[i].movement?.distance ?? 0;
  return sum;
}

// ── Public API ─────────────────────────────────────────────────────────────────
//
// videos parameter is optional: when provided, video timeline telemetry
// (GoPro gForce, stability) is included in overlay frames. Without it,
// those fields are null (acceptable — activity telemetry is still complete).

export function buildRenderManifest(session: SessionJSON, videoFiles?: import('../parser/types').VideoJSON[]): RenderManifest {
  const { activity, candidates, conflicts, report, id: sessionId, createdAt } = session.session;
  const actPts        = activity.activity.timeline;
  const actTimestamps = actPts.map(p => p.timestamp);

  // Compute intensity once — masterScore for overlay frames, profile for activity metadata.
  // SessionJSON doesn't store it (would double size) so we re-derive here from the same rules.
  const { masterScore, profile: sportProfile } = computeIntensity(activity, session.session.rules.intensity);

  const renderMode: RenderMode = report.renderMode;

  // Build per-video lookup maps
  type VideoLookup = {
    vidPts:          VideoTimelinePoint[];
    vidTimestamps:   number[];
    offsetMs:        number;
    videoStartUtcMs: number;
    duration:        number;
  };
  const videoLookup = new Map<string, VideoLookup>();
  for (const vr of session.session.videos) {
    // Try to get full video timeline from optional videos parameter
    const fullVideo = videoFiles?.find(v => v.video.metadata.fileName === vr.source.fileName);
    const vidPts    = fullVideo?.video.timeline ?? [];
    videoLookup.set(vr.source.fileName, {
      vidPts,
      vidTimestamps:   vidPts.map(p => p.timestamp),
      offsetMs:        vr.sync.offsetMs,
      videoStartUtcMs: vr.source.creationTime,
      duration:        vr.source.duration,
    });
  }

  // ── Build clips (narrative order: activityStartMs ascending) ───────────────
  const sortedCandidates = [...candidates].sort((a, b) => a.activityStartMs - b.activityStartMs);

  const clips: RenderClip[] = sortedCandidates.map(c => {
    const lookup    = videoLookup.get(c.videoId);
    const offsetMs  = lookup?.offsetMs        ?? 0;
    const vidPts    = lookup?.vidPts          ?? [];
    const vidTs     = lookup?.vidTimestamps   ?? [];
    const videoStartUtcMs = lookup?.videoStartUtcMs ?? 0;

    const { transitionIn, transitionOut } = deriveTransitions(c.type);

    const includeOverlay = renderMode === 'FULL_TELEMETRY' || renderMode === 'PARTIAL_TELEMETRY';

    let overlay: RenderFrame[] | null = null;
    if (includeOverlay) {
      overlay = buildOverlay(c, actPts, actTimestamps, vidPts, vidTs, offsetMs, c.videoStartSec, videoStartUtcMs);
      enrichOverlayIntensity(overlay, c, actPts, actTimestamps, masterScore);
    }

    const stats = includeOverlay && overlay
      ? computeStats(overlay)
      : computeStats([]);  // empty stats for VIDEO_ONLY / MAP_ONLY

    return {
      id:           c.id,
      videoFile:    c.videoId,
      sceneType:    c.type,
      confidence:   c.confidence,
      label:        c.label,
      seekIn:       c.videoStartSec,
      seekOut:      c.videoEndSec,
      duration:     c.videoEndSec - c.videoStartSec,
      playbackSpeed:  derivePlaybackSpeed(c.type),
      transitionIn,
      transitionOut,
      overlay,
      stats,
      activityStartMs:    c.activityStartMs,
      activityEndMs:      c.activityEndMs,
      activityStartDistM: cumulativeDistAtMs(actPts, actTimestamps, c.activityStartMs),
    };
  });

  // ── Activity metadata ───────────────────────────────────────────────────────
  const { metadata, summary } = activity.activity;

  // ── syncMeta ────────────────────────────────────────────────────────────────
  const syncMeta = session.session.videos.map((vr: VideoSyncResult) => ({
    videoFile:       vr.source.fileName,
    method:          vr.sync.method,
    confidence:      vr.sync.confidence,
    driftPpm:        vr.sync.driftPpm,
    offsetMs:        vr.sync.offsetMs,
    isOverlayUsable: vr.sync.isOverlayUsable,
  }));

  return {
    version:   RENDER_MANIFEST_VERSION,
    sessionId,
    createdAt,

    activity: {
      name:          metadata.activityName,
      type:          metadata.activityType,
      date:          new Date(metadata.startTime).toISOString(),
      totalDistM:    summary.totalDistance,
      movingTimeSec: metadata.movingTime,
      elevGainM:     summary.elevationGain,
      elevLossM:     summary.elevationLoss,
      maxSpeedKmh:   summary.maxSpeed * 3.6,
      avgHR:         summary.avgHeartRate,
      maxHR:         summary.maxHeartRate,
      sportProfile:  sportProfile,
    },

    trackPath: buildTrackPath(actPts),
    clips,
    conflicts,
    quality: report,
    syncMeta,
  };
}

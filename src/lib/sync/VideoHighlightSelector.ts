/**
 * VideoHighlightSelector — scene selection for VIDEO_ONLY render mode.
 *
 * Used when no activity data is available or sync quality is too low to
 * rely on GPS/sensor data from the activity. Selects highlights from the
 * video's own internal telemetry (no external APIs, no Gemini for V1).
 *
 * Strategy 1 — Sensor peaks (GoPro with accel/gyro):
 *   Detects windows of high gForce magnitude. Sorts by peak intensity.
 *   These represent impacts, drops, and exciting terrain moments.
 *
 * Strategy 2 — Uniform sampling (iPhone, DJI, Insta360):
 *   Divides the video into equal segments and picks the middle of each.
 *   Ensures geographic distribution of clips across the recording.
 *
 * All candidates are tagged sensorLimited: true so the UI can inform
 * the user that selection was data-limited.
 */

import type { VideoJSON, VideoTimelinePoint } from '../parser/types';
import type { HighlightCandidate } from './types';

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CLIPS    = 5;
const DEFAULT_CLIP_SEC     = 15;   // duration of each selected clip
const GFORCE_WINDOW_SEC    = 5;    // sliding window for gForce peak detection
const GFORCE_THRESHOLD     = 1.5;  // g magnitude above which a window is "exciting"

// ── Strategy 1: gForce peaks (GoPro) ─────────────────────────────────────────

function selectBySensorPeaks(
  vidPts:   VideoTimelinePoint[],
  duration: number,
  maxClips: number,
  clipSec:  number,
): HighlightCandidate[] {
  // Compute sliding window averages of gForce
  const windowPts = GFORCE_WINDOW_SEC;   // roughly 1 pt/sec from video timeline
  const peaks: Array<{ t: number; avgGForce: number }> = [];

  for (let i = windowPts; i < vidPts.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - windowPts; j <= i; j++) {
      const gf = vidPts[j].sensors.gForce;
      if (gf != null) { sum += gf; count++; }
    }
    if (count === 0) continue;
    const avgGForce = sum / count;
    if (avgGForce >= GFORCE_THRESHOLD) {
      peaks.push({ t: vidPts[i].t, avgGForce });
    }
  }

  if (peaks.length === 0) return [];

  // Sort by intensity descending, deduplicate within clipSec
  peaks.sort((a, b) => b.avgGForce - a.avgGForce);
  const selected: typeof peaks = [];
  for (const p of peaks) {
    const tooClose = selected.some(s => Math.abs(s.t - p.t) < clipSec);
    if (!tooClose) {
      selected.push(p);
      if (selected.length >= maxClips) break;
    }
  }

  return selected.map((p, i) => {
    const seekIn  = Math.max(0, p.t - clipSec / 2);
    const seekOut = Math.min(duration, seekIn + clipSec);
    return {
      id:              `C4_${i}`,
      type:            'TECHNICAL' as const,
      videoId:         '',
      activityStartMs: 0,
      activityEndMs:   0,
      videoStartSec:   seekIn,
      videoEndSec:     seekOut,
      score:           Math.min(1, p.avgGForce / 3.0),
      confidence:      'LOW' as const,
      zone:            'INSIDE' as const,
      label:           'EXCITING MOMENT',
      metrics:         { avgGForce: p.avgGForce },
      ruleIds:         ['video-sensor.gforce'],
      sensorLimited:   true,
      sensorLimitedReason: 'Selected from video accelerometer — no activity data available',
    };
  });
}

// ── Strategy 2: Uniform sampling (no sensor data) ────────────────────────────

function selectByUniformSampling(
  duration: number,
  maxClips: number,
  clipSec:  number,
): HighlightCandidate[] {
  if (duration <= 0) return [];

  const segmentSec = duration / maxClips;
  const results: HighlightCandidate[] = [];

  for (let i = 0; i < maxClips; i++) {
    const center  = segmentSec * i + segmentSec / 2;
    const seekIn  = Math.max(0, center - clipSec / 2);
    const seekOut = Math.min(duration, seekIn + clipSec);
    if (seekOut - seekIn < 3) continue;  // skip tiny trailing segment

    results.push({
      id:              `C6_${i}`,
      type:            'FLOW' as const,
      videoId:         '',
      activityStartMs: 0,
      activityEndMs:   0,
      videoStartSec:   seekIn,
      videoEndSec:     seekOut,
      score:           0.10,
      confidence:      'LOW' as const,
      zone:            'INSIDE' as const,
      label:           'HIGHLIGHT',
      metrics:         { segmentIndex: i },
      ruleIds:         ['video-selector.uniform'],
      sensorLimited:   true,
      sensorLimitedReason: 'Selected by uniform sampling — no telemetry available',
    });
  }
  return results;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface VideoSelectorOptions {
  maxClips?: number;
  clipSec?:  number;
}

export function selectVideoHighlights(
  video:   VideoJSON,
  options: VideoSelectorOptions = {},
): HighlightCandidate[] {
  const maxClips = options.maxClips ?? DEFAULT_MAX_CLIPS;
  const clipSec  = options.clipSec  ?? DEFAULT_CLIP_SEC;
  const duration = video.video.metadata.duration;
  const vidPts   = video.video.timeline;
  const fileName = video.video.metadata.fileName;

  // Strategy 1: GoPro sensor peaks
  const hasSensors = vidPts.some(p => p.sensors.gForce != null);
  const candidates = hasSensors
    ? selectBySensorPeaks(vidPts, duration, maxClips, clipSec)
    : selectByUniformSampling(duration, maxClips, clipSec);

  // Tag with video file name
  for (const c of candidates) c.videoId = fileName;

  return candidates;
}

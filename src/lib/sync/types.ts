/**
 * Sync layer types — SessionJSON, RenderManifest and supporting interfaces.
 *
 * Data flow:
 *   ActivityJSON + VideoJSON[] → SessionJSON (analysis + candidates + conflicts)
 *                              → RenderManifest (compact input for the render engine)
 */

import type { ActivityJSON, VideoJSON } from '../parser/types';

// ── Scene classification ───────────────────────────────────────────────────────

export type SceneType       = 'CLIMB' | 'DESCENT' | 'SPRINT' | 'TECHNICAL' | 'SUFFER' | 'FLOW';
export type SceneConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type SceneZone       = 'INSIDE' | 'NEAR' | 'FAR';
export type SyncMethod      = 'gps-position' | 'speed-ncc' | 'accel-ncc' | 'exif-timestamp' | 'manual';
export type RenderMode      = 'FULL_TELEMETRY' | 'PARTIAL_TELEMETRY' | 'MAP_ONLY' | 'VIDEO_ONLY';
export type TransitionType  = 'cut' | 'fade' | 'dissolve' | 'speed-ramp-in' | 'speed-ramp-out';

// ── VideoMeta — lightweight video reference (no full VideoJSON in session) ─────

export interface VideoMeta {
  fileName:     string;
  device:       string;
  duration:     number;         // seconds
  fps:          number | null;
  resolution:   string | null;
  creationTime: number;         // Unix ms UTC
}

// ── Highlight candidate ────────────────────────────────────────────────────────

export interface HighlightCandidate {
  id:              string;          // 'C1_0', 'C2_1', etc.
  type:            SceneType;
  videoId:         string;          // VideoMeta.fileName
  activityStartMs: number;          // Unix ms in activity timeline
  activityEndMs:   number;
  videoStartSec:   number;          // seconds into the video file
  videoEndSec:     number;
  score:           number;          // 0–1 composite score
  confidence:      SceneConfidence;
  zone:            SceneZone;
  label:           string;          // 'BRUTAL CLIMB', 'WILD DESCENT', etc.
  metrics:         Record<string, number>;
  ruleIds:         string[];
  sensorLimited:   boolean;
  sensorLimitedReason?: string;
}

// ── Per-video sync metadata ────────────────────────────────────────────────────

export interface VideoSyncResult {
  /** Lightweight metadata — full VideoJSON stays in video.json on disk. */
  source: VideoMeta;

  sync: {
    offsetMs:          number;   // activity_time = video_time − offsetMs
    driftPpm:          number;   // clock drift rate (0 = not detected)
    confidence:        number;   // 0–1
    method:            SyncMethod;
    clockConfidence:   number;   // from VideoJSON.video.time.clockConfidence
    isOverlayUsable:   boolean;  // true = sync is reliable enough for telemetry
    gpsLockOffsetMs:   number;   // ms until GPS lock from video start
    syncQualityM:      number;   // mean haversine residual of matched pairs (m)
  };

  coverage: {
    activityStartMs: number;
    activityEndMs:   number;
    overlapFraction: number;   // 0–1 fraction of activity covered
  };
}

// ── Video overlap conflict ────────────────────────────────────────────────────

export interface ConflictRecord {
  type:            'video_overlap';
  activityStartMs: number;
  activityEndMs:   number;
  videos:          VideoMeta[];
  reason:          string;       // human-readable, forwarded to UI
}

// ── Quality report — drives render mode and user-facing messaging ─────────────

export interface QualityReport {
  renderMode:       RenderMode;
  syncMethod:       SyncMethod;
  syncConfidence:   number;
  isOverlayUsable:  boolean;
  activityScore:    number;    // activity.quality.overallScore
  dataRichness:     number;    // fraction of optional fields available (HR, cadence, etc.)
  userMessage:      string;    // plain-language explanation for the UI
  fallbackReason?:  string;    // set when renderMode is degraded from FULL_TELEMETRY
}

// ── Session quality summary ────────────────────────────────────────────────────

export interface SessionQuality {
  syncScore:      number;
  coverageScore:  number;
  candidateCount: number;
}

// ── Unified session output ─────────────────────────────────────────────────────

export interface SessionJSON {
  session: {
    id:        string;
    createdAt: number;

    activity:   ActivityJSON;
    videos:     VideoSyncResult[];

    candidates: HighlightCandidate[];
    conflicts:  ConflictRecord[];
    rules:      RulesConfig;
    quality:    SessionQuality;
    report:     QualityReport;
  };
}

// ── Render engine input ────────────────────────────────────────────────────────

export interface RenderFrame {
  t:              number;          // seconds from clip start
  speedKmh:       number;
  hr:             number | null;
  gradePct:       number;          // positive = uphill, negative = downhill
  elevationM:     number;
  distFromStartM: number;          // cumulative activity distance
  lat:            number;
  lon:            number;
  heading:        number;          // 0–360 degrees
  intensity:      number;          // 0–1 from IntensityScorer
  isMoving:       boolean;
  stability:      number | null;   // GoPro only (0–1)
  gForce:         number | null;   // GoPro only (g magnitude)
}

export interface RenderClip {
  id:          string;
  videoFile:   string;
  sceneType:   SceneType;
  confidence:  SceneConfidence;
  label:       string;

  seekIn:          number;         // seconds into the video file
  seekOut:         number;
  duration:        number;         // seekOut − seekIn

  playbackSpeed:   number;         // 1.0 | 0.75 | 0.5
  transitionIn:    TransitionType;
  transitionOut:   TransitionType;

  /** null when renderMode is VIDEO_ONLY or MAP_ONLY */
  overlay: RenderFrame[] | null;

  stats: {
    peak: { speedKmh: number; hr: number | null; gradePct: number; gForce: number | null };
    avg:  { speedKmh: number; hr: number | null; gradePct: number; intensity: number };
  };

  activityStartMs:    number;
  activityEndMs:      number;
  activityStartDistM: number;
}

export interface RenderManifest {
  version:   string;     // "1.0.0"
  sessionId: string;
  createdAt: number;

  activity: {
    name:          string;
    type:          string;
    date:          string;   // ISO 8601
    totalDistM:    number;
    movingTimeSec: number;
    elevGainM:     number;
    elevLossM:     number;
    maxSpeedKmh:   number;
    avgHR:         number | null;
    maxHR:         number | null;
    sportProfile:  'CLIMB' | 'DESCENT' | 'MIXED';
  };

  /** Decimated GPS path for map rendering (max 500 points). */
  trackPath: Array<{
    lat: number;
    lon: number;
    ele: number;
    t:   number;    // seconds from activity start (for animated map cursor)
  }>;

  /** Clips in narrative order (activityStartMs ascending). */
  clips: RenderClip[];

  conflicts: ConflictRecord[];
  quality:   QualityReport;

  syncMeta: Array<{
    videoFile:       string;
    method:          SyncMethod;
    confidence:      number;
    driftPpm:        number;
    offsetMs:        number;
    isOverlayUsable: boolean;
  }>;
}

// ── Rules config ───────────────────────────────────────────────────────────────

export interface IntensityWeights {
  hr:       number;
  speed:    number;
  gradient: number;
  accel:    number;
  power:    number;
  gyro:     number;
}

export interface RulesConfig {
  version: string;

  intensity: {
    weights: {
      climb:   IntensityWeights;
      descent: IntensityWeights;
      mixed:   IntensityWeights;
    };
  };

  scenes: {
    climb: {
      windowSec:         number;
      coveragePct:       number;
      hrNormThreshold:   number;
      gradientPct:       number;
    };
    descent: {
      windowSec:             number;
      coveragePct:           number;
      speedNormThreshold:    number;
      gradientPct:           number;
    };
    sprint: {
      windowSec:             number;
      speedDeltaFraction:    number;
    };
    technical: {
      windowSec:             number;
      coveragePct:           number;
      accelNormThreshold:    number;
      minSpeedNorm:          number;
      maxSpeedNorm:          number;
    };
    suffer: {
      windowSec:             number;
      coveragePct:           number;
      hrNormThreshold:       number;
      maxSpeedNorm:          number;
    };
    flow: {
      climbWindowSec:        number;
      descentWindowSec:      number;
      maxGapSec:             number;
      minClimbGradient:      number;
      minDescentGradient:    number;
    };
  };

  sync: {
    spatialThresholdM:    number;
    timeWindowMs:         number;
    binMs:                number;
    minVoteShare:         number;
    nccRangeMs:           number;
    nccStepMs:            number;
    nccMinConfidence:     number;
    speedFilterKmh:       number;
    speedSpikeKmh:        number;
    /** clockConfidence threshold above which GPS UTC identity is assumed (offset≈0).
     *  1.0 = GPS satellite clock only. Lower values include NTP-synced cameras. */
    gpsUtcClockThreshold: number;
  };

  candidateSelection: {
    maxPerType:               number;
    minGapMs:                 number;
    maxCandidates:            number;
    zoneMultipliers:          { inside: number; near: number; far: number };
    videoMarginMs:            number;
    overlapConflictThreshold: number;  // fraction of shorter video; above = detect overlap
    overlapTiebreakPct:       number;  // score diff below this → conflict; above → auto-select
  };
}

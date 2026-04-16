/**
 * Parser types — core interfaces for the Lens parser layer.
 *
 * Design principles:
 *   - FileInput is platform-agnostic: browser File and NodeFileAdapter both satisfy it.
 *   - Parser is a plugin contract: each device gets one file implementing this interface.
 *   - ParseResult is the normalized output delivered to the Engine.
 */

// ── Platform bridge ───────────────────────────────────────────────────────────
//
// IMPORTANT: Parsers MUST NOT use `File`, `window`, `document`, `DOMParser`,
// `self`, or `new Worker()` directly — only this interface.

export interface FileSlice {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileInput {
  name: string;
  size: number;
  /** Read a byte range without loading the full file (ranged I/O). */
  slice(start: number, end: number): FileSlice;
  /** Read the entire file as ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Read the entire file as UTF-8 text. */
  text(): Promise<string>;
}

// ── Activity JSON — production schema ─────────────────────────────────────────

export type ActivityVendor = 'garmin' | 'suunto' | 'strava' | 'wahoo' | 'polar' | 'coros' | 'apple' | 'unknown';
export type ActivityFormat = 'gpx' | 'fit' | 'tcx';
export type VideoFormat    = 'gopro-mp4' | 'iphone-mov' | 'insta360-mp4' | 'dji-mp4';

export interface ActivityMetadata {
  source:     ActivityFormat;   // file format
  vendor:     ActivityVendor;   // detected from file content
  device:     string;           // device/app name (e.g. "Garmin Fenix 7")
  activityName: string;         // from <trk><name> or file_id
  activityType: string;         // e.g. "mountain_biking", "running"
  startTime:  number;           // Unix ms UTC
  endTime:    number;           // Unix ms UTC
  totalTime:  number;           // seconds (endTime - startTime)
  movingTime: number;           // seconds (excluding stops)
  boundingBox: {
    minLat: number;             // southernmost point
    maxLat: number;             // northernmost point
    minLon: number;             // westernmost point
    maxLon: number;             // easternmost point
  };
  sampling: {
    isRegular:      boolean;    // true if stdDev/mean < 20%
    avgInterval:    number;     // mean seconds between points
    medianInterval: number;     // p50 — more robust than mean for smart recording
    minInterval:    number;     // shortest gap (seconds)
    maxInterval:    number;     // longest gap (seconds)
  };
  time: {
    isUTC:           boolean;   // true when timestamps carry Z / +00:00
    timezoneOffset:  number;    // minutes from UTC (e.g. -420 for UTC-7)
    clockConfidence: number;    // 0–1: FIT=1.0 (GPS), GPX+Z=0.9, no TZ=0.5
    isMonotonic:     boolean;   // true when timestamps strictly increase (no resets)
  };
}

export interface ActivitySummary {
  totalDistance:   number;         // meters
  elevationGain:   number;         // meters (positive only)
  elevationLoss:   number;         // meters (absolute value)
  avgSpeed:        number;         // m/s (moving average)
  maxSpeed:        number;         // m/s
  avgHeartRate:    number | null;  // bpm
  maxHeartRate:    number | null;  // bpm
  avgCadence:      number | null;  // rpm
  avgPower:        number | null;  // watts
  stops:           number;         // count of distinct stop events
  totalStopTime:   number;         // seconds
}

export interface TimelineMovement {
  distance:       number;                    // meters from previous point
  speed:          number;                    // m/s (instantaneous, from haversine or device)
  speedSmoothed:  number;                    // m/s (±4-point moving average — use for engine decisions)
  speedSource:    'device' | 'computed';     // device = native sensor value; computed = haversine/dt
  acceleration:   number;                    // m/s² (speed delta / time delta)
  verticalSpeed:  number;                    // m/s (positive = climbing)
  grade:          number;                    // fraction (0.05 = 5% grade)
}

export interface TimelineDirection {
  heading:    number;  // degrees 0-360 (compass bearing to next point)
  turnAngle:  number;  // degrees (-180 to +180, positive = right)
}

export interface TimelineBiometrics {
  heartRate?:   number;  // bpm
  cadence?:     number;  // rpm
  power?:       number;  // watts
  temperature?: number;  // °C
}

export interface TimelineDerived {
  isMoving:     boolean;
  isStop:       boolean;
  isClimbing:   boolean;
  isDescending: boolean;
}

export interface TimelineQuality {
  gpsSignalQuality: number;  // 0-1 (1 = perfect signal)
  hasHeartRate:     boolean;
  hasCadence:       boolean;
  hasPower:         boolean;
}

export interface TimelinePoint {
  t:           number;  // seconds from activity start (float — for engine sync)
  dt:          number;  // seconds since previous point (0 for first point)
  timestamp:   number;  // Unix ms UTC (absolute)
  position:    { lat: number; lon: number };
  elevation:   number;  // meters
  movement:    TimelineMovement;
  direction:   TimelineDirection;
  biometrics:  TimelineBiometrics;
  derived:     TimelineDerived;
  quality:     TimelineQuality;
}

export interface LapData {
  index:         number;
  startTime:     number;               // Unix ms
  endTime:       number;               // Unix ms
  distance:      number;               // meters
  duration:      number;               // seconds
  avgSpeed:      number;               // m/s
  avgHeartRate:  number | null;
  elevationGain: number;
  source:        'device' | 'computed'; // device = native lap from FIT/TCX; computed = stop-based
}

export interface ActivitySegment {
  type:      'moving' | 'stop';
  startMs:   number;  // Unix ms
  endMs:     number;  // Unix ms
  durationS: number;  // seconds
}

export interface ActivityQuality {
  overallScore: number;  // 0-1
  gpsQuality: {
    signalConsistency: number;  // 0-1
    noiseLevel:        number;  // 0-1 (lower = cleaner)
    gaps:              number;  // count of gaps > 10 seconds
  };
  dataCompleteness: {
    heartRate: number;  // 0-1 fraction of points with HR
    cadence:   number;  // 0-1
    power:     number;  // 0-1
  };
}

export interface ActivityNormalization {
  parserVersion: string;        // semver — bump when schema changes
  sourceFormat:  ActivityFormat; // redundant with metadata.source, explicit here for contract
  fieldsMapped:  string[];      // optional sensor fields actually present in the source file
}

export interface ActivitySync {
  hasAbsoluteTime:    boolean;  // timestamps are UTC and clock is reliable
  hasLocation:        boolean;  // GPS coordinates present
  clockConfidence:    number;   // 0-1 — copy of metadata.time.clockConfidence
  samplingConfidence: number;   // 0-1 — regularity + gap-adjusted
  syncScore:          number;   // 0-1 — composite readiness for video sync
}

export interface ActivityJSON {
  activity: {
    metadata:      ActivityMetadata;
    summary:       ActivitySummary;
    normalization: ActivityNormalization;
    sync:          ActivitySync;
    timeline:      TimelinePoint[];
    segments:      ActivitySegment[];
    laps:          LapData[];
    quality:       ActivityQuality;
  };
}

// ── Video JSON schema ─────────────────────────────────────────────────────────

export interface VideoMetadata {
  source:       string;        // 'gopro' | 'iphone' | 'samsung' | 'pixel' | 'insta360' | 'dji' | 'mobile'
  device:       string;        // e.g. "GoPro Hero 11", "Galaxy S25 Ultra"
  fileName:     string;
  duration:     number;        // seconds
  fps:          number | null; // from moov/trak/stts binary parsing
  resolution:   string | null; // '4K' | '2.7K' | '1080p' | '720p' | 'WxH'
  codec:        string | null; // 'H.264' | 'H.265' | 'VP9' | 'AV1'
  creationTime: number;        // Unix ms UTC (first GPS timestamp or container date)
  timezone:     string;        // 'UTC' for GPS-based devices
  fileSizeMB:   number;
}

export interface VideoTime {
  startTimeUtc:    number;  // Unix ms
  endTimeUtc:      number;  // Unix ms
  duration:        number;  // seconds
  clockConfidence: number;  // 0-1: GoPro GPS=1.0, iPhone=0.9
}

export interface VideoSpatial {
  hasGps:      boolean;
  boundingBox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
}

export interface VideoTimelinePoint {
  t:         number;        // seconds from video start (float)
  timestamp: number;        // Unix ms UTC
  fix:       0 | 2 | 3;    // GPS fix quality (0=none, 2=2D, 3=3D)
  frame: {
    index: number;          // Math.round(t × fps) — 0 when fps unknown
  };
  position: {
    lat: number;
    lon: number;
    ele: number;            // meters
  };
  movement: {
    speed:    number;       // m/s
    gpsSpeed: boolean;      // true = value comes from GPS sensor
  };
  sensors: {
    gForce?: number;                          // ACCL 3D magnitude in g
    accel?:  [number, number, number];        // raw [x,y,z] in m/s² (for NCC)
    gyro?:   { x: number; y: number; z: number }; // raw vector (rad/s)
  };
  quality: {
    stability:  number;     // 0-1 (derived from gyro magnitude)
    motionBlur: number;     // 0-1 (derived from angular velocity)
  };
}

export interface VideoSegment {
  id:         string;
  startT:     number;    // seconds from video start
  endT:       number;    // seconds from video start
  type:       'high_motion' | 'low_motion' | 'static';
  confidence: number;    // 0-1
}

export interface VideoFeatures {
  hasGps:           boolean;
  hasAccelerometer: boolean;
  hasGyro:          boolean;
  hasAudio:         boolean;
  hasStabilization: boolean;
}

export interface VideoAlignmentHints {
  hasAbsoluteTime:  boolean;  // GPS UTC timestamps available
  hasGpsTrack:      boolean;
  gpsLockOffsetMs:  number;   // ms from video start until GPS locked (0 = locked from start)
  syncScore:        number;   // 0-1 composite sync readiness
}

export interface VideoQuality {
  overallScore:   number;  // 0-1
  stabilityScore: number;  // 0-1 (mean gyro stability)
  gpsQuality:     number;  // 0-1 (fraction of points with fix >= 2)
}

export interface VideoJSON {
  video: {
    metadata:       VideoMetadata;
    time:           VideoTime;
    spatial:        VideoSpatial;
    timeline:       VideoTimelinePoint[];
    segments:       VideoSegment[];
    features:       VideoFeatures;
    alignmentHints: VideoAlignmentHints;
    quality:        VideoQuality;
  };
}

// ── ParseResult union ─────────────────────────────────────────────────────────

export type ParsedActivity = {
  kind: 'activity';
  data: ActivityJSON;
};

export type ParsedVideo = {
  kind: 'video';
  data: VideoJSON;
};

export type ParseResult = ParsedActivity | ParsedVideo;

// ── Parser plugin contract ────────────────────────────────────────────────────
//
// Adding a new device:
//   1. Create src/lib/parser/parsers/{activity|video}/your-device.ts
//   2. Implement this interface
//   3. Add one import line in src/lib/parser/index.ts

export interface Parser {
  readonly id:          string;
  readonly displayName: string;
  canParse(file: FileInput): boolean | Promise<boolean>;
  parse(file: FileInput): Promise<ParseResult>;
}

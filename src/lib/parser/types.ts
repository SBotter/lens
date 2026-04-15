/**
 * Parser types — core interfaces for the Lens parser layer.
 *
 * Design principles:
 *   - FileInput is platform-agnostic: a browser File and a NodeFileAdapter both satisfy it.
 *   - Parser is a plugin contract: each device gets one file implementing this interface.
 *   - ParseResult is the normalized output delivered to the Engine.
 *
 * Output schema (ActivityPoint / VideoPoint) is a placeholder.
 * Replace with the production spec when delivered.
 */

// ── Output schema (placeholder — will be replaced) ───────────────────────────

export interface ActivityPoint {
  lat:    number;
  lon:    number;
  ele:    number;  // metres above sea level
  time:   number;  // Unix timestamp ms (UTC)
  hr?:    number;  // heart rate bpm
  cad?:   number;  // cadence rpm
  power?: number;  // watts
  speed?: number;  // m/s
}

export interface VideoPoint {
  lat:    number;
  lon:    number;
  ele:    number;
  time:   number;
  speed?: number;  // m/s
  accel?: [number, number, number];  // [x, y, z] m/s²
  gyro?:  [number, number, number];  // [x, y, z] rad/s
}

// ── Metadata ──────────────────────────────────────────────────────────────────

export type ActivityFormat = 'gpx' | 'fit' | 'tcx';
export type VideoFormat    = 'gopro-mp4' | 'iphone-mov' | 'insta360-mp4' | 'dji-mp4';

export interface ActivityMeta {
  sourceFormat: ActivityFormat;
  deviceName:   string;    // e.g. "Garmin Forerunner 965"
  startTime:    number;    // Unix ms UTC
  durationMs:   number;
  pointCount:   number;
  sensors: {
    hasHR:    boolean;
    hasCad:   boolean;
    hasPower: boolean;
  };
}

export interface VideoMeta {
  sourceFormat:     VideoFormat;
  deviceName:       string;   // e.g. "GoPro HERO12 Black"
  startTime:        number;   // Unix ms UTC (recording start)
  durationMs:       number;
  pointCount:       number;
  gpsVideoOffsetMs: number;   // delay between recording start and first GPS fix
  hasGPS:           boolean;
}

// ── Parsed outputs ────────────────────────────────────────────────────────────

export type ParsedActivity = {
  kind:   'activity';
  points: ActivityPoint[];
  meta:   ActivityMeta;
};

export type ParsedVideo = {
  kind:   'video';
  points: VideoPoint[];
  meta:   VideoMeta;
};

export type ParseResult = ParsedActivity | ParsedVideo;

// ── Platform bridge ───────────────────────────────────────────────────────────
//
// FileInput is the single abstraction that makes every parser work in both
// the browser (native File object satisfies this interface) and Node.js
// (NodeFileAdapter implements it using fs.open for ranged reads).
//
// IMPORTANT: Parsers MUST NOT use `File`, `window`, `document`, `DOMParser`,
// `self`, or `new Worker()` directly — only this interface.

export interface FileSlice {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileInput {
  name: string;
  size: number;
  /** Read a byte range without loading the full file. */
  slice(start: number, end: number): FileSlice;
  /** Read the entire file as ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Read the entire file as UTF-8 text. */
  text(): Promise<string>;
}

// ── Parser plugin contract ────────────────────────────────────────────────────
//
// Adding a new device:
//   1. Create src/lib/parser/parsers/{activity|video}/your-device.ts
//   2. Implement this interface
//   3. Add one import line in src/lib/parser/index.ts
//   No other changes needed.

export interface Parser {
  /** Unique identifier, e.g. 'gopro-gpmf', 'activity/gpx' */
  readonly id: string;
  /** Human-readable name for logs and UI */
  readonly displayName: string;
  /**
   * Fast heuristic: returns true if this parser can handle the file.
   * Should use only filename and extension — no file I/O.
   * May be async for EXIF-based detection.
   */
  canParse(file: FileInput): boolean | Promise<boolean>;
  /** Full parse — returns normalized ParseResult. */
  parse(file: FileInput): Promise<ParseResult>;
}

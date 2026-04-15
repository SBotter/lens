# Lens Parser — Architecture Reference

**Last updated:** 2026-04-15 (schema v1.1.0)
**Status:** Production — GPX, FIT, TCX complete. Video parsers: GoPro (complete), iPhone (complete), Insta360/DJI (stubs).

---

## Table of Contents

1. [Role in the Lens Pipeline](#1-role-in-the-lens-pipeline)
2. [Directory Structure](#2-directory-structure)
3. [Core Interfaces](#3-core-interfaces)
4. [Parser Registry](#4-parser-registry)
5. [Shared Physics Pipeline (`_physics.ts`)](#5-shared-physics-pipeline-_physicsts)
6. [Activity Parsers](#6-activity-parsers)
   - [GPX](#61-gpx-parser)
   - [FIT](#62-fit-parser)
   - [TCX](#63-tcx-parser)
7. [Differences Between GPX, FIT, and TCX Parsing](#7-differences-between-gpx-fit-and-tcx-parsing)
8. [Output Schema — `ActivityJSON`](#8-output-schema--activityjson)
9. [Why This Structure Exists](#9-why-this-structure-exists)
10. [Platform Bridge — `NodeFileAdapter`](#10-platform-bridge--nodefileadapter)
11. [CLI](#11-cli)
12. [Video Sync Readiness](#12-video-sync-readiness)
13. [Architectural Rules](#13-architectural-rules)
14. [Extending the Parser Layer](#14-extending-the-parser-layer)

---

## 1. Role in the Lens Pipeline

```
Input files (GPX / FIT / TCX / MP4 / MOV)
        │
        ▼
   Parser Layer   ◄──── this document
  (src/lib/parser)
        │
        │  ActivityJSON  ← normalized, format-agnostic
        │  VideoJSON     ← timeline + sensors + metadata
        ▼
   Mix Layer  (activity + video → aligned telemetry)
        │
        ▼
   Engine Layer  (aligned telemetry → narrative + highlights)
```

The parser layer has one contract: accept any file, identify it, and produce a **canonical, format-agnostic JSON**. The Mix layer never sees GPX, FIT, or TCX — it always receives the same `ActivityJSON` structure regardless of source format or device brand.

---

## 2. Directory Structure

```
src/lib/parser/
├── types.ts                   # All TypeScript types (FileInput, Parser, ActivityJSON…)
├── registry.ts                # ParserRegistry singleton
├── index.ts                   # Imports all parsers — one import registers them
├── NodeFileAdapter.ts         # Node.js FileInput wrapper (CLI use)
└── parsers/
    ├── activity/
    │   ├── _physics.ts        # Shared pipeline: RawPoint → ActivityJSON
    │   ├── gpx.ts             # GPX parser
    │   ├── fit.ts             # FIT binary parser
    │   └── tcx.ts             # TCX (Training Center XML) parser
    └── video/
        ├── gopro.ts           # GoPro GPMF parser (GPMF telemetry)
        ├── iphone.ts          # iPhone MOV parser (moov atom GPS)
        ├── _iphone-moov.ts    # Binary helpers (portable, no DOM)
        ├── insta360.ts        # Insta360 stub
        └── dji.ts             # DJI stub
```

---

## 3. Core Interfaces

### `FileInput` — platform bridge

Both the browser `File` API and `NodeFileAdapter` implement this interface. Parsers use only this — never `window`, `DOMParser`, or `fs` directly.

```typescript
export interface FileInput {
  name: string;
  size: number;
  slice(start: number, end: number): FileSlice;  // ranged I/O (critical for large video)
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
```

### `Parser` — plugin contract

```typescript
export interface Parser {
  readonly id:          string;   // e.g. 'activity/gpx', 'gopro-gpmf'
  readonly displayName: string;
  canParse(file: FileInput): boolean | Promise<boolean>;
  parse(file: FileInput): Promise<ParseResult>;
}
```

### `ParseResult` — discriminated union

```typescript
export type ParseResult = ParsedActivity | ParsedVideo;

export type ParsedActivity = { kind: 'activity'; data: ActivityJSON };
export type ParsedVideo    = { kind: 'video'; points: VideoPoint[]; meta: VideoMeta };
```

---

## 4. Parser Registry

`src/lib/parser/registry.ts` holds a singleton that all parsers self-register into at import time:

```typescript
class ParserRegistry {
  register(parser: Parser): void
  async resolve(file: FileInput): Promise<Parser | null>
}
```

`src/lib/parser/index.ts` is the single entry point:

```typescript
import './parsers/activity/gpx';      // side-effect: registers GpxParser
import './parsers/activity/fit';      // side-effect: registers FitActivityParser
import './parsers/activity/tcx';      // side-effect: registers TcxParser
import './parsers/video/gopro';
import './parsers/video/iphone';
import './parsers/video/insta360';
import './parsers/video/dji';
export { registry } from './registry';
```

`registry.resolve(file)` iterates registered parsers in import order and returns the first where `canParse()` returns true. Detection is content-based — extension is a hint, not a requirement.

---

## 5. Shared Physics Pipeline (`_physics.ts`)

This is the heart of the activity parser layer. All three parsers convert their source data into `RawPoint[]`, then call this pipeline. Changes here affect every format simultaneously.

### 5.1 `RawPoint` — common input format

```typescript
export interface RawPoint {
  lat:             number;   // decimal degrees
  lon:             number;   // decimal degrees
  ele:             number;   // meters
  time:            number;   // Unix ms UTC
  hr?:             number;   // bpm
  cad?:            number;   // rpm
  pwr?:            number;   // watts
  temp?:           number;   // °C
  speed?:          number;   // m/s — device-native (preferred over haversine)
  nativeDistance?: number;   // m  — per-point delta from device cumulative distance (FIT/TCX)
  hacc?:           number;   // m  — horizontal accuracy (Apple Health)
}
```

The presence of `speed` and `nativeDistance` determines how motion is computed and what `speedSource` is reported per timeline point. If `speed` is set by the parser, the timeline point carries `speedSource: "device"`. If absent, the physics pipeline computes speed from haversine/dt and reports `speedSource: "computed"`.

### 5.2 `computePhysics(raw: RawPoint[]): PhysicsPoint[]`

Processes each point relative to its predecessor:

| Field | Computation |
|-------|-------------|
| `dt` | `(cur.time - prev.time) / 1000` in seconds |
| `distance` | `nativeDistance` if available, else haversine |
| `speed` | device-native `raw.speed` if set, else `distance / dt` |
| `acceleration` | `(speed − prevSpeed) / dt` |
| `vertSpeed` | `(ele − prevEle) / dt` |
| `grade` | `dEle / distance` (only when distance > 1m to avoid noise) |
| `heading` | look-ahead bearing (cur→next) for smooth rotation |
| `turn` | shortest signed angle from previous heading |

**Distance and speed preference order:**
1. `nativeDistance` / `speed` from device (FIT and TCX with `TPX.Speed`) — most accurate
2. Haversine from lat/lon — fallback for GPX and points without device data

### 5.3 `smoothedElevations()` — adaptive window

GPS altitude noise makes raw elevation gain accumulation unreliable. A moving average is applied before accumulating gain/loss:

```
window = ±max(2, min(15, round(30 / avgIntervalS)))
```

| Recording frequency | Window | Covers |
|--------------------|--------|--------|
| 1 s/point          | ±15 pts | ±15 s |
| 5 s/point          | ±6 pts  | ±30 s |
| 60 s/point         | ±2 pts  | ±2 min |

Targets ~30 seconds of data regardless of device recording mode.

### 5.4 `computePerPointQuality()` — GPS signal score

Assigns a 0–1 quality score per point:

- **Apple Health (`hacc` present):** `max(0, 1 − hacc × 0.01)` — direct from accuracy field
- **Stationary points:** 1.0 (no motion jitter to penalize)
- **Moving points:** deviation from ±4-point smoothed speed → `max(0, 1 − deviation × 0.5)`

### 5.5 Stop detection

A point is a stop when `speed < 0.3 m/s` (~1 km/h). A continuous run ≥ 5 seconds becomes a `StopEvent`. Used to compute `movingTime`, `summary.stops`, `summary.totalStopTime`, and to build `segments[]` and computed laps.

### 5.6 `buildSegments()` — explicit moving/stop arrays

Converts stop events into an ordered list of `ActivitySegment` entries:

```typescript
{ type: 'moving' | 'stop', startMs: number, endMs: number, durationS: number }
```

The Mix layer uses these to mask stop periods during cross-correlation and to identify candidate sync windows (activity is most distinguishable during high-motion segments).

### 5.7 `buildLaps()` — stop-based lap detection (GPX fallback)

When no native laps are provided, lap boundaries are placed at stop start/end points. Each lap includes `source: "computed"`. FIT and TCX bypass this by passing native laps via `AssembleOpts.laps` (which carry `source: "device"`).

### 5.8 `assemble()` — final output

```typescript
export function assemble(pts: PhysicsPoint[], opts: AssembleOpts): ActivityJSON
```

`AssembleOpts` additions beyond basic identity fields:

```typescript
clockConfidence?: number;  // parser-set: FIT=1.0, TCX=0.9, GPX+Z=0.9, no TZ=0.5
laps?:            LapData[];  // if native, carry source: 'device'
```

Computes:
- `metadata` — sampling stats, bounding box, time block (with `clockConfidence` + `isMonotonic`)
- `summary` — totals (distance, elevation, HR, stops, speed)
- `normalization` — `parserVersion`, `sourceFormat`, `fieldsMapped`
- `sync` — composite sync readiness block
- `timeline` — one `TimelinePoint` per input point
- `segments` — ordered moving/stop segment list
- `laps` — native (FIT/TCX) or stop-detected (GPX)
- `quality` — GPS and biometric data completeness scores

#### `isMonotonic` check

Verified by a single O(n) pass. If any timestamp ≤ previous, `isMonotonic = false`. Devices occasionally produce duplicate or reversed timestamps near GPS lock loss. The Mix layer uses this to decide whether to interpolate or reject points during alignment.

#### Derived flags (kinematic only — no business logic)

```typescript
derived: {
  isMoving:     speed >= 0.3 m/s
  isStop:       speed < 0.3 m/s
  isClimbing:   moving AND (vertSpeed > 0.05 m/s OR grade > 2%)
  isDescending: moving AND (vertSpeed < -0.05 m/s OR grade < -2%)
}
```

Sprint and high-effort detection are explicitly excluded — these are Engine decisions, not parser decisions.

---

## 6. Activity Parsers

### 6.1 GPX Parser

**File:** `src/lib/parser/parsers/activity/gpx.ts`
**Detection:** Content-based — first 512 bytes contain `<gpx` tag. Extension optional.

**Clock confidence:** `0.9` for timestamps ending in `Z`, `0.5` for timestamps with local offset or no timezone.

**Vendor detection:** Two-pass to prevent Garmin namespace URLs in Wahoo/Strava/Polar files triggering false positives:
1. `creator` attribute extracted with regex — checked first
2. URL-stripped header text — fallback

**Sensor extraction** from `<trkpt><extensions>`:

| Vendor | Structure | Fields |
|--------|-----------|--------|
| Garmin / Wahoo / Polar / COROS | `<TrackPointExtension>` | hr, cad, atemp, speed |
| Suunto / Strava / generic | direct children | hr, cadence, power |
| Apple Health | flat extensions | speed, hAcc |

**Speed source:** `computed` unless device exports speed in extensions (Polar, Wahoo with `<speed>`).

**Laps:** Stop-detected, `source: "computed"`.

---

### 6.2 FIT Parser

**File:** `src/lib/parser/parsers/activity/fit.ts`
**Library:** `fit-file-parser` with `{ force: true, speedUnit: 'm/s', mode: 'cascade' }`
**Detection:** `.fit` extension OR magic bytes 8–11 = `".FIT"` (ASCII 46 70 73 84)

**Clock confidence:** `1.0` — FIT timestamps come from GPS satellite clock, not device clock.

**Key transforms:**

| Raw FIT value | Transform |
|---------------|-----------|
| Timestamps | `Date` → `.getTime()` (UTC ms) |
| Lat/lon | Semicircles → degrees × `180/2³¹`. Auto-detected: if `|val| ≤ 180`, already in degrees |
| Distance | Cumulative meters → per-point delta `max(0, cur − prev)` |
| Speed | `enhanced_speed ?? speed` (already m/s from library) |
| Altitude | `enhanced_altitude ?? altitude` |
| Cadence | `cadence + fractional_cadence` |

**Speed source:** `device` — FIT always provides native speed from the device sensor.

**File identity:** Library uses `file_ids[]` (array). Device name from `device_infos[0].product_name`.

**Timezone:** `activity.local_timestamp − activity.timestamp` in minutes.

**Laps:** Native device laps from `session.laps[]`, `source: "device"`.

---

### 6.3 TCX Parser

**File:** `src/lib/parser/parsers/activity/tcx.ts`
**Library:** `fast-xml-parser` with `removeNSPrefix: true`
**Detection:** `.tcx` extension OR `<TrainingCenterDatabase` in first 512 bytes

**Clock confidence:** `0.9` — TCX timestamps are always UTC by spec but come from device clock (not GPS).

**TCX structure:**
```
TrainingCenterDatabase
└── Activities
    └── Activity @Sport
        ├── Creator.Name
        └── Lap @StartTime
            ├── TotalTimeSeconds, DistanceMeters, AverageHeartRateBpm
            └── Track
                └── Trackpoint
                    ├── Time, Position.{Lat,Lon}
                    ├── AltitudeMeters, DistanceMeters (cumulative)
                    ├── HeartRateBpm.Value, Cadence
                    └── Extensions.TPX.{Speed, Watts}
```

After `removeNSPrefix`, `ns3:TPX` → `TPX`, `ns3:Speed` → `Speed`.

**Speed source:** `device` when `<TPX><Speed>` is present (Garmin, Wahoo, Polar); `computed` otherwise.

**Vendor detection:** Three-pass (no creator attribute in TCX):
1. `Creator.Name` string — exact vendor names, then Garmin device prefixes
2. `Author.Name` — "Connect Api" / "Garmin Connect" → garmin
3. URL-stripped header text fallback

**Laps:** Native `<Lap>` elements, `source: "device"`. Elevation gain is recomputed from the lap's own trackpoints.

---

## 7. Differences Between GPX, FIT, and TCX Parsing

| Capability | GPX | TCX | FIT |
|-----------|-----|-----|-----|
| **Clock confidence** | 0.5–0.9 (device clock) | 0.9 (UTC spec, device clock) | 1.0 (GPS satellite) |
| **Native speed** | Rarely (some vendors) | Sometimes (`<TPX><Speed>`) | Always |
| **Native distance** | No | Yes (cumulative) | Yes (cumulative) |
| **Native laps** | No | Yes (`<Lap>` elements) | Yes (button/auto-lap) |
| **Power** | Rarely | Sometimes (`<TPX><Watts>`) | Always (if device supports) |
| **Cadence** | Rarely | Yes (`<Cadence>`) | Always |
| **Temperature** | Sometimes | Rarely | Yes |
| **Sub-second sampling** | No | No | Yes (some devices) |
| **Timezone info** | In timestamp suffix | Always UTC | From local/UTC delta |
| **Speed source** | computed (usually) | device or computed | device always |
| **Lap source** | computed | device | device |
| **fieldsMapped typical** | heartRate, temperature | heartRate, cadence, nativeSpeed, nativeDistance | heartRate, cadence, power, temperature, nativeSpeed, nativeDistance |

### GPX limitations and how they are handled

- **No native speed:** haversine + time delta used. `speedSource: "computed"`. Higher noise at short intervals.
- **No native distance:** haversine used. Cumulative distance less accurate than FIT/TCX for short segments.
- **No native laps:** stop-detection creates computed laps. `laps[].source: "computed"`.
- **Irregular sampling:** smart-recording devices produce gaps. `sampling.isRegular` will be false; smoothing window adapts.
- **Timezone ambiguity:** if no `Z` suffix, `clockConfidence` drops to 0.5. The Mix layer uses `syncScore` to decide whether UTC-based alignment is reliable.

### FIT richness and how it is preserved

FIT provides the most complete dataset. Nothing is recomputed when device data is available:
- Device native speed is used directly, never overwritten by haversine.
- Cumulative distance delta is used as `nativeDistance`, never overwritten by haversine.
- GPS satellite timestamps give `clockConfidence: 1.0` — the Mix layer can trust these for direct UTC alignment.
- All six sensor channels (HR, cadence, power, temperature, native speed, native distance) will appear in `fieldsMapped`.

### TCX as the middle ground

TCX provides structured laps and usually has cadence and speed. Timestamps are always UTC. Its main limitation versus FIT is that it lacks fractional cadence, sub-second records, and the device-identity metadata that FIT exposes. Speed may or may not be present depending on the device.

---

## 8. Output Schema — `ActivityJSON`

All three parsers produce identical `ActivityJSON`. The structure is the same regardless of source format — fields are null or absent when not available, never fabricated.

```typescript
interface ActivityJSON {
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
```

### `ActivityMetadata`

```typescript
{
  source:       'gpx' | 'fit' | 'tcx'
  vendor:       'garmin' | 'wahoo' | 'suunto' | 'strava' | 'polar' | 'coros' | 'apple' | 'unknown'
  device:       string           // e.g. "Garmin Fenix 7", "Wahoo ELEMNT ROAM"
  activityName: string
  activityType: string           // e.g. "mountain_biking", "cycling", "running"
  startTime:    number           // Unix ms UTC
  endTime:      number           // Unix ms UTC
  totalTime:    number           // seconds
  movingTime:   number           // seconds (excludes stops)
  boundingBox:  { minLat, maxLat, minLon, maxLon }
  sampling: {
    isRegular:      boolean      // stdDev/mean < 20%
    avgInterval:    number       // mean seconds between points
    medianInterval: number       // p50 — better for smart-recording devices
    minInterval:    number
    maxInterval:    number
  }
  time: {
    isUTC:           boolean
    timezoneOffset:  number      // minutes from UTC
    clockConfidence: number      // 0–1: FIT=1.0, GPX+Z=0.9, TCX=0.9, no TZ=0.5
    isMonotonic:     boolean     // false = clock resets or GPS dropout artifacts
  }
}
```

### `ActivityNormalization`

```typescript
{
  parserVersion: string        // semver — bump when schema changes (current: "1.1.0")
  sourceFormat:  'gpx' | 'fit' | 'tcx'
  fieldsMapped:  string[]      // which optional sensor fields were present in source
                               // possible values: 'heartRate', 'cadence', 'power',
                               //   'temperature', 'nativeSpeed', 'nativeDistance'
}
```

### `ActivitySync`

Pre-computed sync readiness for the Mix layer. Eliminates the need to re-scan the timeline to decide sync strategy.

```typescript
{
  hasAbsoluteTime:    boolean  // isUTC && clockConfidence >= 0.7
  hasLocation:        boolean  // GPS present (always true when timeline exists)
  clockConfidence:    number   // 0–1 — mirrors metadata.time.clockConfidence
  samplingConfidence: number   // 0–1 — regularity + gap-adjusted
  syncScore:          number   // 0–1 — composite readiness score
}
```

`syncScore` formula: `0.40 × clockConfidence + 0.30 × samplingConfidence + 0.20 × gpsSignalConsistency + 0.10 × hasLocation`

### `TimelinePoint`

```typescript
{
  t:          number          // seconds from activity start (FLOAT — engine sync)
  dt:         number          // seconds since previous point (0 for first point)
  timestamp:  number          // Unix ms UTC (absolute)
  position:   { lat, lon }
  elevation:  number          // meters (raw GPS, not smoothed)
  movement: {
    distance:      number     // meters from previous point
    speed:         number     // m/s (instantaneous — raw)
    speedSmoothed: number     // m/s (±4-point average — USE THIS for sync NCC)
    speedSource:   'device' | 'computed'  // device = sensor value; computed = haversine/dt
    acceleration:  number     // m/s²
    verticalSpeed: number     // m/s (positive = climbing)
    grade:         number     // fraction (0.05 = 5% grade)
  }
  direction: {
    heading:   number         // degrees 0-360
    turnAngle: number         // degrees (-180 to +180)
  }
  biometrics: {               // all optional — absent when not recorded
    heartRate?:   number
    cadence?:     number
    power?:       number
    temperature?: number
  }
  derived: {                  // kinematic facts only — no business logic
    isMoving:     boolean
    isStop:       boolean
    isClimbing:   boolean
    isDescending: boolean
  }
  quality: {
    gpsSignalQuality: number  // 0-1
    hasHeartRate:     boolean
    hasCadence:       boolean
    hasPower:         boolean
  }
}
```

Note: `t` is a float. For 1 Hz recording it is effectively an integer, but for FIT files with sub-second intervals (e.g. 0.5 s) it carries fractional seconds. Do not round it in the Engine.

### `ActivitySegment`

```typescript
{ type: 'moving' | 'stop', startMs: number, endMs: number, durationS: number }
```

Ordered chronologically. The Mix layer uses these to:
- Mask stop periods during cross-correlation
- Identify candidate windows for sync (activity is most distinguishable during motion)

### `LapData`

```typescript
{
  index:         number
  startTime:     number       // Unix ms
  endTime:       number       // Unix ms
  distance:      number       // meters
  duration:      number       // seconds
  avgSpeed:      number       // m/s
  avgHeartRate:  number | null
  elevationGain: number       // meters
  source:        'device' | 'computed'  // device = FIT/TCX native; computed = GPX stop-based
}
```

### `ActivityQuality`

```typescript
{
  overallScore: number        // 0-1 composite
  gpsQuality: {
    signalConsistency: number // 0-1 mean per-point quality (moving points only)
    noiseLevel:        number // 0-1 fraction of points with quality < 0.85
    gaps:              number // count of gaps > 10 s
  }
  dataCompleteness: {
    heartRate: number         // fraction of points with HR
    cadence:   number
    power:     number
  }
}
```

---

## 9. Why This Structure Exists

### The problem with simple parsers

A naive parser extracts coordinates and timestamps. That is enough to draw a map. It is not enough to synchronize with a video.

Video synchronization requires knowing:
- **When** the activity happened (absolute UTC, with confidence)
- **How reliably** the timestamps can be trusted (clock quality varies by device and format)
- **Whether** the sampling is regular enough for cross-correlation
- **Which** signals are available for matching (speed NCC requires speed; position histogram requires GPS)
- **Where** the activity is dynamic vs stopped (stops degrade correlation)

The `sync` block, `normalization.fieldsMapped`, `time.clockConfidence`, `time.isMonotonic`, `segments[]`, and `movement.speedSource` all exist to answer these questions without requiring the Mix layer to re-analyze the full timeline.

### Multi-device, multi-format support

GPX, FIT, and TCX have fundamentally different reliability profiles. Rather than degrading FIT to GPX's capability level (the naive approach), the schema exposes richness when available:

- FIT `speedSource: "device"` tells the Mix layer to trust the speed signal for NCC.
- GPX `speedSource: "computed"` tells it to expect more noise in the speed signal.
- `clockConfidence: 1.0` on FIT enables direct UTC-based sync without a search window.
- `clockConfidence: 0.5` on ambiguous GPX triggers a position-histogram or NCC search.

### Engine contract philosophy

The Engine receives data, not format assumptions. It does not know or care whether the source was a Garmin `.fit` or a Strava `.gpx`. The `normalization` block records provenance for debugging. The `sync` block tells the Engine what strategy to use. The `segments` block tells it where to look. Everything else is physics.

---

## 10. Platform Bridge — `NodeFileAdapter`

`src/lib/parser/NodeFileAdapter.ts` wraps a file system path into the `FileInput` interface so the CLI can use the exact same parsers as the browser.

```typescript
const file = await NodeFileAdapter.fromPath('./Input/gpx/garmin/activity.gpx');
const parser = await registry.resolve(file);
const result = await parser.parse(file);
```

**`slice()` is ranged I/O** — opens the file, reads only the requested byte range, closes it. Critical for large video files: `canParse()` reads 12 bytes; `iphone-moov` reads only the last ~200 KB of a 4 GB file.

---

## 11. CLI

```bash
npm run parse -- ./Input/<folder>
```

Scans the folder for all files, resolves each against the registry, parses recognized files, and writes output to `<folder>/json/`:

```
Input/gpx/garmin/
├── activity_22330059321.gpx
└── json/
    └── activity.json        ← produced by the CLI
```

Multiple files in one folder produce an array in `activity.json`. The CLI always runs verbose (per-file stats printed to stdout).

---

## 12. Video Sync Readiness

The `ActivitySync` block pre-answers the strategy question for the Mix layer. The four sync strategies and their schema dependencies:

### Strategy 1 — Direct UTC Timestamp Match

**When to use:** `sync.hasAbsoluteTime === true` AND `sync.clockConfidence >= 0.9`

**Fields used:** `timeline[i].timestamp` (Unix ms UTC)

GoPro GPMF timestamps come from GPS satellites — they are GPS UTC, same reference as FIT. Walk both timelines by timestamp and align directly. Most accurate strategy.

### Strategy 2 — Position Histogram (±120 s window)

**When to use:** `sync.hasLocation === true` AND clock confidence is lower

**Fields used:** `timeline[i].position.lat`, `timeline[i].position.lon`

Cross-reference spatial positions in a ±120 s search window using 5 s bins. Tolerates clock drift.

### Strategy 3 — Speed NCC Cross-Correlation

**When to use:** `'nativeSpeed' in normalization.fieldsMapped` OR FIT source (always has speed)

**Fields used:** `timeline[i].movement.speedSmoothed`, `metadata.sampling.medianInterval`

Normalized cross-correlation of speed profiles. Use `speedSmoothed` (not raw `speed`) to reduce impulse noise. `medianInterval` drives resampling target for the correlation grid.

### Strategy 4 — Accelerometer NCC Fallback

**When to use:** No GPS in video, or poor GPS in both

**Fields used:** `timeline[i].movement.acceleration` (activity side) + GoPro ACCL stream (video side)

Cross-correlation of activity acceleration against GoPro vertical accelerometer. Lower reliability, but works without GPS or speed data.

### Strategy selection using `sync` block

```
clockConfidence >= 1.0 AND hasAbsoluteTime → Strategy 1 (UTC match)
clockConfidence >= 0.7 AND medianInterval < 2 → Strategy 3 (speed NCC)
clockConfidence >= 0.7 AND medianInterval < 30 → Strategy 2 (position histogram)
else → Strategy 4 (accelerometer NCC)
```

---

## 13. Architectural Rules

1. **No browser globals in parsers.** `DOMParser`, `window`, `document`, `self`, `new Worker()` are forbidden inside `src/lib/parser/`. Only `FileInput` methods are used.

2. **`fast-xml-parser` for all XML.** Isomorphic — works in browser and Node without shims.

3. **`NodeFileAdapter.slice()` is ranged I/O.** Never call `arrayBuffer()` on a video file just to read a header.

4. **One environment check only.** `typeof window !== 'undefined'` appears once — in `gopro.ts` for the `gpmf-extract` `browserMode` flag.

5. **Parser output is format-agnostic.** The Mix layer receives `ActivityJSON` with no knowledge of the source format. `metadata.source` and `normalization.sourceFormat` record it for debugging.

6. **Physics changes apply to all parsers.** `_physics.ts` is the single source of truth. A fix to elevation computation, stop detection, or quality scoring applies to GPX, FIT, and TCX simultaneously.

7. **No business logic in parsers.** Sprint detection, high-effort classification, and narrative decisions belong in the Engine. Parsers only expose kinematic facts (`isMoving`, `isStop`, `isClimbing`, `isDescending`).

8. **Adding a parser = one file + one import.** Create the file, implement `Parser`, call `registry.register()`, add one import in `index.ts`.

---

## 14. Extending the Parser Layer

### Add a new activity format

1. Create `src/lib/parser/parsers/activity/your-format.ts`
2. Parse source into `RawPoint[]` — set `speed` if device-native, `nativeDistance` if cumulative
3. Set `clockConfidence` based on timestamp source reliability
4. Build native `LapData[]` with `source: 'device'` if the format has them
5. Call `computePhysics(rawPoints)` → `assemble(physics, opts)` → return `{ kind: 'activity', data }`
6. Add one import in `src/lib/parser/index.ts`

### Add a new video format

1. Replace stub in `src/lib/parser/parsers/video/your-format.ts`
2. Return `{ kind: 'video', points: VideoPoint[], meta: VideoMeta }`
3. `VideoPoint` carries `lat`, `lon`, `ele`, `time`, optional `speed`, `accel[]`, `gyro[]`

### Modify physics or schema

Edit `_physics.ts` and/or `types.ts`. Bump `PARSER_VERSION` in `_physics.ts`. Run:

```bash
npm run parse -- ./Input/gpx/garmin
npm run parse -- ./Input/fit/wahoo
npm run parse -- ./Input/tcx/garmin
```

to verify consistent output across all three formats before committing.

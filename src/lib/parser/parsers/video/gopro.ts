/**
 * GoPro MP4 Video Parser — GPMF telemetry
 *
 * Extracts GPS, accelerometer, and gyroscope telemetry from the GPMF
 * (GoPro Metadata Format) binary track embedded in GoPro MP4/360 files.
 *
 * Libraries:
 *   gpmf-extract    — locates and reads the GPMF binary stream
 *   gopro-telemetry — decodes GPMF into structured GPS / sensor data
 *
 * Container probing (fps / resolution / codec / audio):
 *   Done with direct binary moov parsing — not mp4box.
 *   GoPro files write moov AFTER mdat (no faststart), so mp4box would need
 *   to stream the entire 3–4 GB mdat before reaching moov.
 *   findMoovContent() reads only the 16-byte headers of top-level boxes
 *   to locate moov, then does a single ranged read of ~400 KB.
 *
 * Environment:
 *   gpmf-extract uses { browserMode: true } in browser, Buffer in Node.
 *   This is the ONLY environment check in the parser layer.
 */

import gpmfExtract     from 'gpmf-extract';
import goproTelemetry  from 'gopro-telemetry';
import { findMoovContent, probeVideoTrack } from './_isobmff';
import type { ContainerInfo } from './_isobmff';
import { registry }    from '../../registry';
import type {
  Parser, FileInput, ParseResult,
  VideoJSON, VideoTimelinePoint, VideoSegment,
} from '../../types';

// ── Filename patterns ─────────────────────────────────────────────────────────

// HERO:   GH01XXXX.MP4 / GH02XXXX.MP4
// Max360: GX01XXXX.MP4
// Other:  GL, GOPR, GP prefixes
const GOPRO_FILENAME_RE = /^(GH|GX|GL|GOPR|GP)\d/i;

// ── MP4 container probe ───────────────────────────────────────────────────────
// GoPro writes moov AFTER mdat — findMoovContent() handles this via ranged reads.
// probeVideoTrack() is shared across all video parsers (defined in _isobmff.ts).

async function probeMp4Container(file: FileInput): Promise<ContainerInfo> {
  const empty: ContainerInfo = { fps: null, resolution: null, codec: null, durationMs: null, hasAudio: false };
  try {
    const moov = await findMoovContent(file);
    if (!moov) return empty;
    return probeVideoTrack(moov);
  } catch {
    return empty;
  }
}

// ── Stabilisation detection ───────────────────────────────────────────────────

/** GoPro HyperSmooth available from HERO8 onwards.
 *  If model can't be determined, default true — all recent GoPros have HyperSmooth. */
function hasStabilization(deviceName: string): boolean {
  const d = deviceName.toLowerCase();
  const m = d.match(/hero\s*(\d+)/);
  if (m) return parseInt(m[1], 10) >= 8;
  if (/hero\s*[1-7]\b/.test(d)) return false;  // explicitly old model
  return true;  // max, mini, volta, labs, or unknown model — assume HyperSmooth
}

// ── GPS quality helpers ───────────────────────────────────────────────────────

/** Propagate sticky fix field across samples (same logic as GoPro firmware). */
function computeFixPerSample(rawSamples: unknown[]): number[] {
  let current = 0;
  return rawSamples.map((s: unknown) => {
    const sticky = (s as Record<string, unknown>)?.sticky as Record<string, unknown> | undefined;
    if (sticky?.fix !== undefined) current = Number(sticky.fix);
    return current;
  });
}

/** CTS of first GPS-locked sample (fix >= 2). Returns 0 if locked from start. */
function computeGpsLockOffset(rawSamples: unknown[], fixArr: number[]): number {
  for (let i = 0; i < fixArr.length; i++) {
    if (fixArr[i] >= 2) {
      const cts = (rawSamples[i] as Record<string, unknown>)?.cts;
      return typeof cts === 'number' ? Math.round(cts) : 0;
    }
  }
  return 0; // never locked
}

// ── Sensor map ────────────────────────────────────────────────────────────────

/** Build ratio-based ACCL or GYRO sample lookup indexed to GPS5 sample positions. */
function buildRatioSensorLookup(
  sensorSamples: unknown[],
  gpsLength: number,
): Array<[number, number, number] | undefined> {
  return Array.from({ length: gpsLength }, (_, i) => {
    if (sensorSamples.length === 0) return undefined;
    const ratio = gpsLength > 1 ? i / (gpsLength - 1) : 0;
    const idx   = Math.min(Math.round(ratio * (sensorSamples.length - 1)), sensorSamples.length - 1);
    const v = (sensorSamples[idx] as Record<string, unknown>)?.value;
    if (!Array.isArray(v) || v.length < 3) return undefined;
    return [Number(v[0]), Number(v[1]), Number(v[2])] as [number, number, number];
  });
}

// ── Segment builder ───────────────────────────────────────────────────────────

const STATIC_THRESH_MS = 0.5;   // m/s
const MOTION_THRESH_MS = 5.0;   // m/s (~18 km/h)
const MIN_SEG_S        = 3.0;   // minimum segment duration

function classifySpeed(speedMs: number): VideoSegment['type'] {
  if (speedMs < STATIC_THRESH_MS) return 'static';
  if (speedMs < MOTION_THRESH_MS) return 'low_motion';
  return 'high_motion';
}

function buildVideoSegments(timeline: VideoTimelinePoint[]): VideoSegment[] {
  if (timeline.length === 0) return [];

  const segments: VideoSegment[] = [];
  let segId    = 0;
  let segStart = 0;
  let segType  = classifySpeed(timeline[0].movement.speed);
  let lockedInSeg = 0;
  let countInSeg  = 1;

  const flush = (endIdx: number) => {
    const startT = timeline[segStart].t;
    const endT   = timeline[endIdx].t;
    if (endT - startT < MIN_SEG_S) return;
    const confidence = Math.round((lockedInSeg / Math.max(1, countInSeg)) * 100) / 100;
    segments.push({
      id:         `vseg_${++segId}`,
      startT:     Math.round(startT * 100) / 100,
      endT:       Math.round(endT   * 100) / 100,
      type:       segType,
      confidence,
    });
  };

  for (let i = 1; i < timeline.length; i++) {
    const type = classifySpeed(timeline[i].movement.speed);
    if (timeline[i].fix >= 2) lockedInSeg++;
    countInSeg++;

    if (type !== segType) {
      flush(i - 1);
      segStart = i;
      segType  = type;
      lockedInSeg = timeline[i].fix >= 2 ? 1 : 0;
      countInSeg  = 1;
    }
  }
  flush(timeline.length - 1);

  return segments;
}

// ── Bounding box ──────────────────────────────────────────────────────────────

function computeBBox(pts: VideoTimelinePoint[]) {
  if (pts.length === 0) return null;
  let minLat =  Infinity, maxLat = -Infinity;
  let minLon =  Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.position.lat < minLat) minLat = p.position.lat;
    if (p.position.lat > maxLat) maxLat = p.position.lat;
    if (p.position.lon < minLon) minLon = p.position.lon;
    if (p.position.lon > maxLon) maxLon = p.position.lon;
  }
  return {
    minLat: Math.round(minLat * 10000) / 10000,
    maxLat: Math.round(maxLat * 10000) / 10000,
    minLon: Math.round(minLon * 10000) / 10000,
    maxLon: Math.round(maxLon * 10000) / 10000,
  };
}

// ── Parser plugin ─────────────────────────────────────────────────────────────

const GoProParser: Parser = {
  id:          'gopro-gpmf',
  displayName: 'GoPro (GPMF telemetry)',

  async canParse(file: FileInput): Promise<boolean> {
    const name = file.name.toLowerCase();
    if (!/\.(mp4|360)$/.test(name)) return false;
    // Primary: filename convention
    if (GOPRO_FILENAME_RE.test(file.name)) return true;
    // Fallback: check ftyp compatible brands for 'mp41' or 'avc1' is not reliable,
    // but we can check if GPMF-like data exists via file brand check
    try {
      const ab   = await file.slice(0, 32).arrayBuffer();
      const view = new DataView(ab);
      // ftyp box starts at byte 4 (size=4, type=4, brand=4). GoPro uses 'mp41' or 'M4V '
      const brand = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
      return brand === 'mp41' || brand === 'M4V ';
    } catch {
      return false;
    }
  },

  async parse(file: FileInput): Promise<ParseResult> {
    // ── Step 1: MP4 container info (fps, resolution, codec, audio) ────────────
    const container = await probeMp4Container(file);

    // ── Step 2: Extract GPMF stream ───────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extracted: any;
    try {
      // Always use browserMode — it uses file.slice().arrayBuffer() internally (ranged I/O).
      // NodeFileAdapter implements the same slice() contract as browser File,
      // so this works in both environments without loading the whole file into memory.
      extracted = await gpmfExtract(file as unknown as File, { browserMode: true });
    } catch (err: unknown) {
      throw new Error(`GoPro: GPMF extraction failed — ${(err as Error).message}`);
    }

    if (!extracted?.rawData) {
      throw new Error('GoPro: GPMF track is empty or missing');
    }

    // ── Step 3: Decode telemetry streams ──────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let telemetry: Record<string, any>;
    try {
      telemetry = await goproTelemetry(extracted, {
        stream:   ['GPS5', 'ACCL', 'GYRO'],
        progress: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
    } catch (err: unknown) {
      throw new Error(`GoPro: telemetry decode failed — ${(err as Error).message}`);
    }

    // ── Step 4: Extract device and streams ────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const devices = Object.values(telemetry) as Array<Record<string, any>>;
    if (devices.length === 0) throw new Error('GoPro: no telemetry devices found');

    const device  = devices[0];
    const deviceName: string = device.deviceName || 'GoPro';
    const streams = device.streams ?? {};

    const rawSamples: unknown[]  = streams.GPS5?.samples  ?? [];
    const acclSamples: unknown[] = streams.ACCL?.samples  ?? [];
    const gyroSamples: unknown[] = streams.GYRO?.samples  ?? [];

    if (rawSamples.length === 0) {
      throw new Error('GoPro: GPS5 stream not found or empty');
    }

    // ── Step 5: GPS fix propagation and lock detection ────────────────────────
    const fixArr       = computeFixPerSample(rawSamples);
    const gpsLockOffsetMs = computeGpsLockOffset(rawSamples, fixArr);

    // ── Step 6: Ratio-based ACCL / GYRO lookup (handles rate mismatch) ────────
    // ACCL ≈ 200 Hz, GYRO ≈ 200 Hz, GPS5 ≈ 18 Hz — never align by CTS directly
    const acclLookup = buildRatioSensorLookup(acclSamples, rawSamples.length);
    const gyroLookup = buildRatioSensorLookup(gyroSamples, rawSamples.length);

    const G = 9.80665;  // m/s² per g

    // ── Step 7: Filter and build timeline ─────────────────────────────────────
    const fps = container.fps ?? 30; // fallback for frame index computation

    const timeline: VideoTimelinePoint[] = [];

    for (let i = 0; i < rawSamples.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = rawSamples[i] as Record<string, any>;

      const value = s.value;
      if (!Array.isArray(value) || value.length < 4) continue;

      const lat    = Number(value[0]);
      const lon    = Number(value[1]);
      const ele    = Number(value[2]);
      const spdMs  = Number(value[3]);  // GPS5[3] = 2D speed in m/s
      const dateStr: string | undefined = s.date;
      const cts: number | undefined     = s.cts;  // ms from video start

      // ── Filters ─────────────────────────────────────────────────────────────
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) continue;  // null island
      if (!dateStr) continue;                                            // no UTC timestamp
      if (isFinite(spdMs) && spdMs * 3.6 > 150) continue;             // GPS speed spike

      const timestamp = new Date(dateStr).getTime();
      if (isNaN(timestamp)) continue;

      const t = typeof cts === 'number' ? cts / 1000 : timeline.length / fps;

      // ── Sensors ─────────────────────────────────────────────────────────────
      const accel = acclLookup[i];
      const gyro  = gyroLookup[i];

      let gForce: number | undefined;
      if (accel) {
        const mag = Math.sqrt(accel[0] ** 2 + accel[1] ** 2 + accel[2] ** 2);
        gForce = Math.round((mag / G) * 1000) / 1000;
      }

      let gyroObj: { x: number; y: number; z: number } | undefined;
      let gyroMag = 0;
      if (gyro) {
        gyroObj = {
          x: Math.round(gyro[0] * 10000) / 10000,
          y: Math.round(gyro[1] * 10000) / 10000,
          z: Math.round(gyro[2] * 10000) / 10000,
        };
        gyroMag = Math.sqrt(gyro[0] ** 2 + gyro[1] ** 2 + gyro[2] ** 2);
      }

      // ── Point-level quality ──────────────────────────────────────────────────
      const stability  = Math.round(Math.max(0, 1 - gyroMag / 5)   * 10000) / 10000;
      const motionBlur = Math.round(Math.min(1, gyroMag / 3)        * 10000) / 10000;

      const fix = (fixArr[i] >= 2 ? fixArr[i] : 0) as 0 | 2 | 3;

      const pt: VideoTimelinePoint = {
        t:         Math.round(t * 1000) / 1000,
        timestamp,
        fix,
        frame:     { index: Math.round(t * fps) },
        position:  {
          lat: Math.round(lat * 10000) / 10000,
          lon: Math.round(lon * 10000) / 10000,
          ele: Math.round(ele * 100)   / 100,
        },
        movement: {
          speed:    Math.round(spdMs  * 10000) / 10000,
          gpsSpeed: true,
        },
        sensors: {},
        quality: { stability, motionBlur },
      };

      if (gForce !== undefined)    pt.sensors.gForce = gForce;
      if (accel  !== undefined)    pt.sensors.accel  = accel;
      if (gyroObj !== undefined)   pt.sensors.gyro   = gyroObj;

      timeline.push(pt);
    }

    if (timeline.length === 0) {
      throw new Error('GoPro: no valid GPS points after filtering');
    }

    // ── Step 8: Aggregate quality ─────────────────────────────────────────────
    const lockedPts    = timeline.filter(p => p.fix >= 2).length;
    const gpsQuality   = Math.round((lockedPts / timeline.length) * 10000) / 10000;
    const stabilityAvg = Math.round(
      (timeline.reduce((s, p) => s + p.quality.stability, 0) / timeline.length) * 10000
    ) / 10000;
    const syncScore    = Math.round(
      (0.5 * 1.0 +                // clockConfidence always 1.0 for GoPro GPS
       0.3 * gpsQuality +
       0.2 * stabilityAvg) * 10000
    ) / 10000;

    // ── Step 9: Time bounds ───────────────────────────────────────────────────
    const startTimeUtc = timeline[0].timestamp;
    const endTimeUtc   = timeline[timeline.length - 1].timestamp;
    const durationSec  = container.durationMs != null
      ? container.durationMs / 1000
      : (endTimeUtc - startTimeUtc) / 1000;

    // ── Step 10: Assemble VideoJSON ───────────────────────────────────────────
    const data: VideoJSON = {
      video: {
        metadata: {
          source:       'gopro',
          device:       deviceName,
          fileName:     file.name,
          duration:     Math.round(durationSec * 100) / 100,
          fps:          container.fps,
          resolution:   container.resolution,
          codec:        container.codec,
          creationTime: startTimeUtc,
          timezone:     'UTC',
          fileSizeMB:   Math.round((file.size / 1024 / 1024) * 100) / 100,
        },
        time: {
          startTimeUtc,
          endTimeUtc,
          duration:        Math.round(durationSec * 100) / 100,
          clockConfidence: 1.0,  // GPS satellite clock
        },
        spatial: {
          hasGps:      true,
          boundingBox: computeBBox(timeline),
        },
        timeline,
        segments: buildVideoSegments(timeline),
        features: {
          hasGps:           true,
          hasAccelerometer: acclSamples.length > 0,
          hasGyro:          gyroSamples.length > 0,
          hasAudio:         container.hasAudio,
          hasStabilization: hasStabilization(deviceName),
        },
        alignmentHints: {
          hasAbsoluteTime:  true,
          hasGpsTrack:      true,
          gpsLockOffsetMs:  gpsLockOffsetMs,
          syncScore,
        },
        quality: {
          overallScore:   Math.round((0.5 * gpsQuality + 0.3 * stabilityAvg + 0.2 * syncScore) * 10000) / 10000,
          stabilityScore: stabilityAvg,
          gpsQuality,
        },
      },
    };

    return { kind: 'video', data };
  },
};

registry.register(GoProParser);

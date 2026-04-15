/**
 * GoPro MP4 Video Parser (GPMF telemetry)
 *
 * Extracts continuous GPS, accelerometer, and gyroscope telemetry
 * embedded in GoPro MP4 files using the GPMF (GoPro Metadata Format).
 *
 * Libraries:
 *   gpmf-extract   — locates and reads the GPMF binary stream from the MP4 container
 *   gopro-telemetry — decodes GPMF into structured GPS / sensor data
 *
 * Browser vs Node: gpmf-extract accepts a File-like object.
 * The { browserMode } flag switches its internal I/O strategy:
 *   - browserMode: true  → uses File.slice().arrayBuffer() (browser)
 *   - browserMode: false → uses Buffer I/O (Node.js)
 * This is the ONLY environment check in the entire parser layer.
 */

import gpmfExtract     from 'gpmf-extract';
import goproTelemetry  from 'gopro-telemetry';
import { registry }    from '../../registry';
import type { Parser, FileInput, ParseResult, VideoPoint, VideoMeta } from '../../types';

// GoPro filename conventions:
//   HERO:   GH01XXXX.MP4, GH02XXXX.MP4
//   Max360: GX01XXXX.MP4
//   Other:  GL, GOPR, GP prefix
const GOPRO_FILENAME_RE = /^(GH|GX|GL|GOPR|GP)\d/i;

const GoProParser: Parser = {
  id:          'gopro-gpmf',
  displayName: 'GoPro (GPMF telemetry)',

  canParse(file: FileInput): boolean {
    const name = file.name.toLowerCase();
    if (!/\.(mp4|360)$/.test(name)) return false;
    return GOPRO_FILENAME_RE.test(file.name);
  },

  async parse(file: FileInput): Promise<ParseResult> {
    // ── Extract raw GPMF stream from MP4 ──────────────────────────────────
    // gpmf-extract has two overloads: browser (File/Blob) and Node (Buffer).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extracted: any;

    try {
      const isBrowser = typeof window !== 'undefined';
      if (isBrowser) {
        extracted = await gpmfExtract(file as unknown as File, { browserMode: true });
      } else {
        const ab  = await file.arrayBuffer();
        const buf = Buffer.from(ab);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extracted = await (gpmfExtract as any)(buf);
      }
    } catch (err: unknown) {
      throw new Error(`GoPro: GPMF extraction failed — ${(err as Error).message}`);
    }

    // ── Decode GPMF into telemetry streams ─────────────────────────────────
    let telemetry: Record<string, unknown>;
    try {
      telemetry = await goproTelemetry(extracted, {
        stream:    ['GPS5', 'ACCL', 'GYRO', 'CORI'],
        progress:  () => {},
      }) as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      throw new Error(`GoPro: telemetry decode failed — ${(err as Error).message}`);
    }

    // ── Normalize GPS5 stream into VideoPoints ────────────────────────────
    const points: VideoPoint[] = [];
    let deviceName = 'GoPro';
    let startTime  = 0;
    let durationMs = 0;

    // gopro-telemetry output: { '1': { streams: { GPS5: {...}, ACCL: {...} }, deviceName, ... } }
    const devices = Object.values(telemetry) as Array<Record<string, unknown>>;

    for (const device of devices) {
      if (typeof device.deviceName === 'string') {
        deviceName = device.deviceName || deviceName;
      }

      const streams = device.streams as Record<string, unknown> | undefined;
      if (!streams) continue;

      const gps5 = streams['GPS5'] as Record<string, unknown> | undefined;
      if (!gps5) continue;

      const samples = gps5.samples as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(samples)) continue;

      // Build ACCL + GYRO lookup by timestamp for merging
      const acclMap = buildSensorMap(streams['ACCL']);
      const gyroMap = buildSensorMap(streams['GYRO']);

      for (const sample of samples) {
        const value = sample.value as number[] | undefined;
        if (!Array.isArray(value) || value.length < 4) continue;

        const [lat, lon, ele, speed] = value as [number, number, number, number];
        const ts = sample.cts as number | undefined;  // ms from start
        const date = sample.date as string | undefined;

        if (!isFinite(lat) || !isFinite(lon)) continue;

        const time = date ? new Date(date).getTime() : NaN;
        if (isNaN(time)) continue;

        if (startTime === 0) startTime = time;
        durationMs = time - startTime;

        const p: VideoPoint = { lat, lon, ele, time };

        const speedMs = isFinite(speed) ? speed : undefined;
        if (speedMs !== undefined) p.speed = speedMs;

        if (ts !== undefined) {
          const accel = acclMap.get(Math.round(ts));
          const gyro  = gyroMap.get(Math.round(ts));
          if (accel) p.accel = accel;
          if (gyro)  p.gyro  = gyro;
        }

        points.push(p);
      }
    }

    if (points.length === 0) {
      throw new Error('GoPro: no GPS data found in GPMF stream');
    }

    const meta: VideoMeta = {
      sourceFormat:     'gopro-mp4',
      deviceName,
      startTime,
      durationMs,
      pointCount:       points.length,
      gpsVideoOffsetMs: 0,
      hasGPS:           true,
    };

    return { kind: 'video', points, meta };
  },
};

/** Build a Map<roundedCts, [x,y,z]> from an ACCL or GYRO stream for fast merge. */
function buildSensorMap(
  stream: unknown,
): Map<number, [number, number, number]> {
  const map = new Map<number, [number, number, number]>();
  if (!stream || typeof stream !== 'object') return map;

  const samples = (stream as Record<string, unknown>).samples as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(samples)) return map;

  for (const s of samples) {
    const cts   = s.cts as number | undefined;
    const value = s.value as number[] | undefined;
    if (cts !== undefined && Array.isArray(value) && value.length >= 3) {
      map.set(Math.round(cts), [value[0], value[1], value[2]]);
    }
  }
  return map;
}

registry.register(GoProParser);

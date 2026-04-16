/**
 * FIT Activity Parser (Flexible and Interoperable Data Transfer)
 *
 * Binary format used by Garmin, Wahoo, Suunto, Polar, COROS, and others.
 * Richer than GPX: native speed, native laps, power, cadence always present.
 *
 * Key differences from GPX:
 *   - Timestamps are FIT epoch (Dec 31 1989 UTC) → converted to Unix ms UTC
 *   - Lat/lon in semicircles → converted to degrees
 *   - Native cumulative distance → preferred over haversine for per-point delta
 *   - Native laps from device (button press / auto-lap) → used instead of
 *     stop-based auto-detection
 *   - enhanced_altitude / enhanced_speed preferred over altitude / speed
 *   - Always UTC (no timezone ambiguity)
 */

import FitParser    from 'fit-file-parser';
import { registry } from '../../registry';
import type {
  Parser, FileInput, ParseResult, ActivityVendor, LapData,
} from '../../types';
import {
  computePhysics, assemble, numOrUndef,
  type RawPoint,
} from './_physics';

// ── Constants ─────────────────────────────────────────────────────────────────

/** FIT semicircle to decimal degrees. */
const SEMICIRCLE_TO_DEG = 180 / Math.pow(2, 31);

// ── Vendor detection ──────────────────────────────────────────────────────────

function detectFitVendor(mfr: unknown, product: unknown): { vendor: ActivityVendor; device: string } {
  const m = String(mfr ?? '').toLowerCase();
  const p = String(product ?? '');

  const pairs: Array<[string, ActivityVendor, string]> = [
    ['garmin',         'garmin', 'Garmin'],
    ['wahoo',          'wahoo',  'Wahoo'],
    ['suunto',         'suunto', 'Suunto'],
    ['polar',          'polar',  'Polar'],
    ['coros',          'coros',  'COROS'],
    ['apple',          'apple',  'Apple'],
  ];

  for (const [key, vendor, label] of pairs) {
    if (m.includes(key)) {
      const device = p ? `${label} ${p}`.replace(/_/g, ' ').trim() : label;
      return { vendor, device };
    }
  }

  const device = [m, p].filter(Boolean).join(' ').replace(/_/g, ' ') || 'Unknown FIT Device';
  return { vendor: 'unknown', device };
}

// ── Activity type from FIT sport / sub_sport ──────────────────────────────────

function normalizeFitSport(sport: unknown, subSport: unknown): string {
  const s  = String(sport    ?? '').toLowerCase().replace(/\s+/g, '_');
  const ss = String(subSport ?? '').toLowerCase().replace(/\s+/g, '_');

  // Specific combos first
  if (s === 'cycling'  && ss === 'mountain')  return 'mountain_biking';
  if (s === 'cycling'  && ss === 'road')       return 'cycling';
  if (s === 'cycling'  && ss === 'virtual_activity') return 'virtual_ride';
  if (s === 'running'  && ss === 'trail')      return 'trail_run';
  if (s === 'running'  && ss === 'track')      return 'track_run';
  if (s === 'running'  && (ss === 'generic' || ss === '')) return 'running';
  if (s === 'swimming' && ss === 'open_water') return 'open_water_swim';
  if (s === 'fitness_equipment' && ss === 'treadmill')  return 'treadmill';
  if (s === 'fitness_equipment' && ss === 'elliptical') return 'elliptical';

  // Fallback: use sport name as-is
  return s || 'unknown';
}

// ── FIT file parsing ──────────────────────────────────────────────────────────

interface FitData {
  activity?: {
    sessions?: FitSession[];
  };
  records?: FitRecord[];
}

interface FitSession {
  sport?:            string;
  sub_sport?:        string;
  start_time?:       Date;
  laps?:             FitLap[];
}

interface FitLap {
  start_time?:         Date;
  timestamp?:          Date;
  total_elapsed_time?: number;
  total_distance?:     number;
  avg_speed?:          number;
  avg_heart_rate?:     number;
  total_ascent?:       number;
}

interface FitRecord {
  timestamp?:         Date | number;
  position_lat?:      number;
  position_long?:     number;
  altitude?:          number;
  enhanced_altitude?: number;
  heart_rate?:        number;
  cadence?:           number;
  fractional_cadence?:number;
  power?:             number;
  speed?:             number;
  enhanced_speed?:    number;
  distance?:          number;  // cumulative meters
  temperature?:       number;
}

function parseFitBinary(buffer: ArrayBuffer): Promise<FitData> {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force:              true,
      speedUnit:          'm/s',
      lengthUnit:         'm',
      temperatureUnit:    'celsius',
      elapsedRecordField: true,
      mode:               'cascade',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parser.parse(buffer as any, (err: any, result: any) => {
      if (err) reject(new Error(String(err)));
      else     resolve(result as FitData);
    });
  });
}

function extractRecords(data: FitData): FitRecord[] {
  // cascade mode: activity → sessions → laps → records
  const sessions = data.activity?.sessions ?? [];
  const records: FitRecord[] = [];
  for (const session of sessions) {
    for (const lap of (session.laps ?? [])) {
      if (Array.isArray((lap as any).records)) {
        records.push(...(lap as any).records as FitRecord[]);
      }
    }
  }
  // flat mode fallback
  if (records.length === 0 && Array.isArray(data.records)) {
    records.push(...data.records);
  }
  return records;
}

function toUnixMs(ts: Date | number | undefined): number {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts * 1000;
  return NaN;
}

function semicircleToDeg(v: number | undefined): number | undefined {
  if (v == null || !isFinite(v)) return undefined;
  // Values in semicircles are large integers (±2^31). Real degrees are ±90/±180.
  // If already in degree range, return as-is (some library versions auto-convert).
  if (Math.abs(v) <= 180) return v;
  return v * SEMICIRCLE_TO_DEG;
}

// ── Native FIT laps → LapData[] ──────────────────────────────────────────────

function buildFitLaps(sessions: FitSession[]): LapData[] {
  const laps: LapData[] = [];
  let index = 0;

  for (const session of sessions) {
    for (const lap of (session.laps ?? [])) {
      const startMs  = lap.start_time instanceof Date ? lap.start_time.getTime() : NaN;
      const endMs    = lap.timestamp instanceof Date  ? lap.timestamp.getTime()  : NaN;
      if (isNaN(startMs) || isNaN(endMs)) continue;

      laps.push({
        index:         index++,
        startTime:     startMs,
        endTime:       endMs,
        distance:      Math.round((lap.total_distance ?? 0) * 100) / 100,
        duration:      Math.round(lap.total_elapsed_time ?? (endMs - startMs) / 1000),
        avgSpeed:      Math.round((lap.avg_speed ?? 0) * 10000) / 10000,
        avgHeartRate:  lap.avg_heart_rate != null ? Math.round(lap.avg_heart_rate) : null,
        elevationGain: Math.round((lap.total_ascent ?? 0) * 100) / 100,
        source:        'device',
      });
    }
  }

  return laps;
}

// ── Content-based detection ───────────────────────────────────────────────────

async function isFitFile(file: FileInput): Promise<boolean> {
  if (file.name.toLowerCase().endsWith('.fit')) return true;
  // FIT magic: bytes 8–11 = ".FIT" (ASCII 46 70 73 84)
  try {
    const ab  = await file.slice(0, 12).arrayBuffer();
    const buf = new Uint8Array(ab);
    return buf[8] === 46 && buf[9] === 70 && buf[10] === 73 && buf[11] === 84;
  } catch {
    return false;
  }
}

// ── Parser plugin ─────────────────────────────────────────────────────────────

const FitActivityParser: Parser = {
  id:          'activity/fit',
  displayName: 'FIT Activity (Garmin / Wahoo / Suunto / Polar / COROS)',

  async canParse(file: FileInput): Promise<boolean> {
    try { return await isFitFile(file); }
    catch { return false; }
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const buffer = await file.arrayBuffer();
    const data   = await parseFitBinary(buffer);
    const raw    = data as any;

    // ── File identity ─────────────────────────────────────────────────────────
    // fit-file-parser uses file_ids[] (array) not file_id (singular)
    const fileId     = Array.isArray(raw.file_ids) ? raw.file_ids[0] ?? {} : raw.file_id ?? {};
    const deviceInfo = raw.activity?.device_infos?.[0] ?? {};

    // Prefer device_infos[0] for product name (e.g. "ELEMNT ROAM"), fall back to file_id
    const mfr        = fileId.manufacturer ?? deviceInfo.manufacturer ?? '';
    const productName = deviceInfo.product_name ?? fileId.garmin_product ?? fileId.product ?? '';
    const { vendor, device } = detectFitVendor(mfr, productName);

    // ── Session metadata ─────────────────────────────────────────────────────
    const sessions     = data.activity?.sessions ?? [];
    const firstSession = sessions[0] ?? {};
    const activityType = normalizeFitSport(firstSession.sport, firstSession.sub_sport);

    // Activity name: workout name (if set by the athlete) > sport type label
    const activityName = (raw.workout?.wkt_name && raw.workout.wkt_name !== activityType)
      ? String(raw.workout.wkt_name)
      : activityType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());

    // ── Timezone from activity local_timestamp vs UTC timestamp ──────────────
    const utcTs   = raw.activity?.timestamp;
    const localTs = raw.activity?.local_timestamp;
    let timeMeta  = { isUTC: true, timezoneOffset: 0 };
    if (utcTs instanceof Date && localTs instanceof Date) {
      const offsetMs  = localTs.getTime() - utcTs.getTime();
      const offsetMin = Math.round(offsetMs / 60000);
      timeMeta = { isUTC: offsetMin === 0, timezoneOffset: offsetMin };
    }

    // ── Records → RawPoints ──────────────────────────────────────────────────
    const records = extractRecords(data);
    if (records.length === 0) throw new Error('FIT: no records found');

    const rawPoints: RawPoint[] = [];
    let prevCumulativeDist: number | undefined;

    for (const rec of records) {
      const lat = semicircleToDeg(rec.position_lat);
      const lon = semicircleToDeg(rec.position_long);
      const time = toUnixMs(rec.timestamp);

      if (lat === undefined || lon === undefined || isNaN(time)) continue;

      const ele   = numOrUndef(rec.enhanced_altitude ?? rec.altitude) ?? 0;
      const speed = numOrUndef(rec.enhanced_speed    ?? rec.speed);

      // Per-point distance from cumulative distance delta
      let nativeDistance: number | undefined;
      const cumDist = numOrUndef(rec.distance);
      if (cumDist != null && prevCumulativeDist != null) {
        nativeDistance = Math.max(0, cumDist - prevCumulativeDist);
      }
      if (cumDist != null) prevCumulativeDist = cumDist;

      // Fractional cadence: some devices export e.g. cad=85 + fractional_cadence=0.5 → 85.5
      const baseCad = numOrUndef(rec.cadence);
      const fracCad = numOrUndef(rec.fractional_cadence);
      const cad     = baseCad != null
        ? (fracCad != null ? Math.round(baseCad + fracCad) : baseCad)
        : undefined;

      rawPoints.push({
        lat, lon, ele, time,
        hr:             numOrUndef(rec.heart_rate),
        cad,
        pwr:            numOrUndef(rec.power),
        temp:           numOrUndef(rec.temperature),
        speed,
        nativeDistance,
      });
    }

    if (rawPoints.length === 0) throw new Error('FIT: no valid GPS records found');

    // ── Physics pipeline ─────────────────────────────────────────────────────
    const physics = computePhysics(rawPoints);

    // ── Native laps from device ───────────────────────────────────────────────
    const nativeLaps = buildFitLaps(sessions);

    // ── Assemble ──────────────────────────────────────────────────────────────
    const data_ = assemble(physics, {
      source: 'fit',
      activityName,
      activityType,
      vendor,
      device,
      // FIT timestamps come from GPS satellite clock — highest possible confidence
      clockConfidence: 1.0,
      time:   timeMeta,
      laps:   nativeLaps.length > 0 ? nativeLaps : undefined,
    });

    return { kind: 'activity', data: data_ };
  },
};

registry.register(FitActivityParser);

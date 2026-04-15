/**
 * FIT Activity Parser (Flexible and Interoperable Data Transfer)
 *
 * Binary format used by Garmin, Wahoo, Polar, Suunto, and others.
 * Uses fit-file-parser npm package — accepts ArrayBuffer in both browser and Node.
 *
 * Extracts: GPS, elevation, HR, cadence, power, speed.
 */

import FitParser    from 'fit-file-parser';
import { registry } from '../../registry';
import type { Parser, FileInput, ParseResult, ActivityPoint, ActivityMeta } from '../../types';

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

const FitActivityParser: Parser = {
  id:          'activity/fit',
  displayName: 'FIT Activity (Garmin / Wahoo / Polar)',

  canParse(file: FileInput): boolean {
    return file.name.toLowerCase().endsWith('.fit');
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const buffer = await file.arrayBuffer();

    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      // fit-file-parser v2: constructor options, then .parse(buffer, callback)
      const parser = new FitParser({
        force:          true,      // continue on minor errors
        speedUnit:      'm/s',
        lengthUnit:     'm',
        temperatureUnit: 'celsius',
        elapsedRecordField: true,
        mode:           'cascade', // returns nested structure
      });

      parser.parse(buffer as Buffer, (err: Error | null, result: Record<string, unknown>) => {
        if (err) reject(err);
        else     resolve(result);
      });
    });

    // fit-file-parser cascade mode: data.activity.sessions[].laps[].records[]
    // OR data.records[] in list mode. Handle both.
    const rawRecords: Record<string, unknown>[] = extractRecords(data);
    if (rawRecords.length === 0) throw new Error('FIT: no records found');

    // Device name from file_id message
    const fileId   = (data as any)?.file_id ?? {};
    const mfr      = String(fileId.manufacturer ?? '');
    const product  = String(fileId.garmin_product ?? fileId.product ?? '');
    const deviceName = [mfr, product].filter(Boolean).join(' ') || 'Unknown FIT Device';

    const points: ActivityPoint[] = [];
    let hasHR = false, hasCad = false, hasPower = false;

    for (const rec of rawRecords) {
      const lat  = numOrUndef(rec.position_lat);
      const lon  = numOrUndef(rec.position_long);
      const ele  = numOrUndef(rec.altitude ?? rec.enhanced_altitude) ?? 0;
      const ts   = rec.timestamp;
      const time = ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts * 1000 : NaN);

      if (lat === undefined || lon === undefined || isNaN(time)) continue;
      // fit-file-parser returns lat/lon in semicircles — convert to degrees
      const latDeg = lat * (180 / 2147483648);
      const lonDeg = lon * (180 / 2147483648);

      if (!isFinite(latDeg) || !isFinite(lonDeg)) continue;

      const hr    = numOrUndef(rec.heart_rate);
      const cad   = numOrUndef(rec.cadence);
      const power = numOrUndef(rec.power);
      const speed = numOrUndef(rec.speed ?? rec.enhanced_speed);

      if (hr    !== undefined) hasHR    = true;
      if (cad   !== undefined) hasCad   = true;
      if (power !== undefined) hasPower = true;

      const p: ActivityPoint = { lat: latDeg, lon: lonDeg, ele, time };
      if (hr    !== undefined) p.hr    = hr;
      if (cad   !== undefined) p.cad   = cad;
      if (power !== undefined) p.power = power;
      if (speed !== undefined) p.speed = speed;

      points.push(p);
    }

    if (points.length === 0) throw new Error('FIT: no valid GPS records found');

    const meta: ActivityMeta = {
      sourceFormat: 'fit',
      deviceName,
      startTime:   points[0].time,
      durationMs:  points[points.length - 1].time - points[0].time,
      pointCount:  points.length,
      sensors:     { hasHR, hasCad, hasPower },
    };

    return { kind: 'activity', points, meta };
  },
};

/** Extract records array from either cascade or list mode output. */
function extractRecords(data: Record<string, unknown>): Record<string, unknown>[] {
  // Direct list mode
  if (Array.isArray(data.records)) return data.records as Record<string, unknown>[];

  // Cascade mode: activity.sessions[].laps[].records[]
  const activity = (data as any).activity;
  if (!activity) return [];

  const records: Record<string, unknown>[] = [];
  const sessions = Array.isArray(activity.sessions) ? activity.sessions : [];
  for (const session of sessions) {
    const laps = Array.isArray(session.laps) ? session.laps : [];
    for (const lap of laps) {
      const recs = Array.isArray(lap.records) ? lap.records : [];
      records.push(...recs);
    }
  }
  return records;
}

registry.register(FitActivityParser);

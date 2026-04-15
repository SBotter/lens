/**
 * TCX Activity Parser (Training Center XML)
 *
 * Garmin's Training Center exchange format.
 * Supports: HR, cadence, power (TPX extension), altitude.
 *
 * Uses fast-xml-parser (pure JS, isomorphic — no DOMParser).
 */

import { XMLParser } from 'fast-xml-parser';
import { registry }  from '../../registry';
import type { Parser, FileInput, ParseResult, ActivityPoint, ActivityMeta } from '../../types';

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

const TcxParser: Parser = {
  id:          'activity/tcx',
  displayName: 'TCX Activity (Garmin Training Center)',

  canParse(file: FileInput): boolean {
    return file.name.toLowerCase().endsWith('.tcx');
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const xml = await file.text();

    const xmlParser = new XMLParser({
      ignoreAttributes:    false,
      attributeNamePrefix: '@_',
      removeNSPrefix:      true,
      isArray: (name) => ['Activity', 'Lap', 'Track', 'Trackpoint'].includes(name),
    });

    const doc = xmlParser.parse(xml);
    const tcd = doc?.TrainingCenterDatabase;
    if (!tcd) throw new Error('TCX: no <TrainingCenterDatabase> root element');

    const activities = asArray(tcd.Activities?.Activity);
    if (activities.length === 0) throw new Error('TCX: no <Activity> elements found');

    const deviceName: string = String(
      activities[0]?.Creator?.Name ?? 'Unknown Garmin Device'
    );

    const points: ActivityPoint[] = [];
    let hasHR = false, hasCad = false, hasPower = false;

    for (const act of activities) {
      for (const lap of asArray(act.Lap)) {
        for (const track of asArray(lap.Track)) {
          for (const tp of asArray(track.Trackpoint)) {
            const time = tp.Time ? new Date(String(tp.Time)).getTime() : NaN;
            const lat  = numOrUndef(tp.Position?.LatitudeDegrees);
            const lon  = numOrUndef(tp.Position?.LongitudeDegrees);
            const ele  = numOrUndef(tp.AltitudeMeters) ?? 0;

            if (isNaN(time) || lat === undefined || lon === undefined) continue;

            const hr    = numOrUndef(tp.HeartRateBpm?.Value);
            const cad   = numOrUndef(tp.Cadence);
            // TPX extension (Garmin running dynamics / power)
            const power = numOrUndef(tp.Extensions?.TPX?.Watts);
            const speed = numOrUndef(tp.Extensions?.TPX?.Speed);

            if (hr    !== undefined) hasHR    = true;
            if (cad   !== undefined) hasCad   = true;
            if (power !== undefined) hasPower = true;

            const p: ActivityPoint = { lat, lon, ele, time };
            if (hr    !== undefined) p.hr    = hr;
            if (cad   !== undefined) p.cad   = cad;
            if (power !== undefined) p.power = power;
            if (speed !== undefined) p.speed = speed;

            points.push(p);
          }
        }
      }
    }

    if (points.length === 0) throw new Error('TCX: no valid trackpoints found');

    const meta: ActivityMeta = {
      sourceFormat: 'tcx',
      deviceName,
      startTime:   points[0].time,
      durationMs:  points[points.length - 1].time - points[0].time,
      pointCount:  points.length,
      sensors:     { hasHR, hasCad, hasPower },
    };

    return { kind: 'activity', points, meta };
  },
};

registry.register(TcxParser);

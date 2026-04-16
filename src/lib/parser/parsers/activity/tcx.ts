/**
 * TCX Activity Parser (Training Center XML)
 *
 * Garmin's Training Center exchange format. Also exported by Suunto, Polar,
 * and other devices that support the Garmin schema.
 *
 * Structure:
 *   <TrainingCenterDatabase>
 *     <Activities>
 *       <Activity Sport="Biking">
 *         <Lap StartTime="...">
 *           <TotalTimeSeconds>, <DistanceMeters>, <AverageHeartRateBpm>, ...
 *           <Track>
 *             <Trackpoint>
 *               <Time>, <Position>, <AltitudeMeters>, <DistanceMeters>,
 *               <HeartRateBpm>, <Cadence>,
 *               <Extensions><TPX><Speed>, <Watts>
 *
 * Key differences from GPX:
 *   - Laps are explicit in the file (not stop-detected)
 *   - Cumulative distance per trackpoint (use delta for per-point distance)
 *   - Speed and power in <Extensions><TPX> (after removeNSPrefix)
 *   - Creator element gives device name
 *   - No timezone info — timestamps are UTC
 */

import { XMLParser } from 'fast-xml-parser';
import { registry }  from '../../registry';
import type { Parser, FileInput, ParseResult, ActivityVendor, LapData } from '../../types';
import {
  computePhysics, assemble, parseTimeMetadata, numOrUndef,
  accumulateElevation, smoothedElevations,
  type RawPoint,
} from './_physics';

// ── Activity type normalisation ────────────────────────────────────────────────

const TCX_SPORT_MAP: Record<string, string> = {
  'biking':       'cycling',
  'running':      'running',
  'other':        'unknown',
  'multi_sport':  'multi_sport',
  'swimming':     'swimming',
  'hiking':       'hiking',
  'walking':      'walking',
};

function normalizeTcxSport(sport: unknown): string {
  const s = String(sport ?? '').toLowerCase().replace(/\s+/g, '_');
  return (TCX_SPORT_MAP[s] ?? s) || 'unknown';
}

// ── Vendor detection ──────────────────────────────────────────────────────────

async function readHeader(file: FileInput, bytes = 1024): Promise<string> {
  const ab = await file.slice(0, bytes).arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false }).decode(ab);
}

/** Garmin device name prefixes — used when the creator name contains no vendor string. */
const GARMIN_DEVICE_PREFIXES = [
  'edge', 'fenix', 'forerunner', 'vivoactive', 'venu', 'instinct',
  'descent', 'epix', 'tactix', 'marq', 'approach', 'quatix', 'fēnix',
];

function detectTcxVendor(
  header: string, creatorName: string, authorName: string,
): { vendor: ActivityVendor; device: string } {
  const cl = creatorName.toLowerCase();
  const al = authorName.toLowerCase();
  const hl = header.replace(/https?:\/\/[^\s"'>]+/g, '').toLowerCase();

  // Creator name is the most reliable source
  if (cl.includes('garmin'))  return { vendor: 'garmin', device: creatorName };
  if (cl.includes('wahoo'))   return { vendor: 'wahoo',  device: creatorName };
  if (cl.includes('suunto'))  return { vendor: 'suunto', device: creatorName };
  if (cl.includes('polar'))   return { vendor: 'polar',  device: creatorName };
  if (cl.includes('coros'))   return { vendor: 'coros',  device: creatorName };
  if (cl.includes('apple'))   return { vendor: 'apple',  device: creatorName };

  // Known Garmin device name prefixes (e.g. "Edge 130", "Forerunner 955")
  if (GARMIN_DEVICE_PREFIXES.some(p => cl.startsWith(p)))
    return { vendor: 'garmin', device: creatorName };

  // Author.Name: "Connect Api" or "Garmin Connect" → Garmin exported file
  if (al.includes('garmin') || al.includes('connect'))
    return { vendor: 'garmin', device: creatorName };

  // Fallback: header text with URLs stripped
  const fallback = (v: ActivityVendor, d: string) => ({ vendor: v, device: creatorName ? creatorName : d });
  if (hl.includes('garmin'))  return fallback('garmin', 'Garmin Device');
  if (hl.includes('suunto'))  return fallback('suunto', 'Suunto');
  if (hl.includes('polar'))   return fallback('polar',  'Polar');
  if (hl.includes('wahoo'))   return fallback('wahoo',  'Wahoo');
  if (hl.includes('coros'))   return fallback('coros',  'COROS');

  return { vendor: 'unknown', device: creatorName ? creatorName : 'Unknown TCX Device' };
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// ── Parse ─────────────────────────────────────────────────────────────────────

function parseTcx(xml: string): {
  rawPoints:    RawPoint[];
  nativeLaps:   LapData[];
  activityName: string;
  activityType: string;
  creatorName:  string;
  authorName:   string;
  firstTimeStr: string | null;
} {
  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    removeNSPrefix:      true,   // strips ns3:, ns2:, etc.
    isArray: (name) => ['Activity', 'Lap', 'Track', 'Trackpoint'].includes(name),
    parseAttributeValue: true,
  });

  const doc = parser.parse(xml);
  const tcd = doc?.TrainingCenterDatabase;
  if (!tcd) throw new Error('TCX: no <TrainingCenterDatabase> root element');

  const activities = asArray(tcd.Activities?.Activity);
  if (activities.length === 0) throw new Error('TCX: no <Activity> elements found');

  const firstActivity = activities[0];
  const sport         = firstActivity['@_Sport'] ?? 'unknown';
  const activityType  = normalizeTcxSport(sport);
  const creatorName   = String(firstActivity.Creator?.Name ?? '');
  const authorName    = String(tcd.Author?.Name ?? '');

  // Activity name: use the <Id> field (ISO timestamp) as fallback
  const activityName = activityType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const rawPoints:  RawPoint[]  = [];
  const nativeLaps: LapData[]   = [];
  let   firstTimeStr: string | null = null;
  let   lapIndex = 0;

  for (const act of activities) {
    for (const lap of asArray(act.Lap)) {
      const lapStartTimeStr = String(lap['@_StartTime'] ?? '');
      const lapStartMs = lapStartTimeStr ? new Date(lapStartTimeStr).getTime() : NaN;
      const lapDurS    = numOrUndef(lap.TotalTimeSeconds) ?? 0;
      const lapEndMs   = isNaN(lapStartMs) ? NaN : lapStartMs + lapDurS * 1000;
      const lapAvgHR   = numOrUndef(lap.AverageHeartRateBpm?.Value) ?? null;
      const lapDist    = numOrUndef(lap.DistanceMeters) ?? 0;

      // Collect raw points for this lap segment (for elevation gain computation)
      const lapRawPoints: RawPoint[] = [];
      let prevCumulativeDist: number | undefined;

      for (const track of asArray(lap.Track)) {
        for (const tp of asArray(track.Trackpoint)) {
          const timeStr = tp.Time ? String(tp.Time) : null;
          const time    = timeStr ? new Date(timeStr).getTime() : NaN;
          const lat     = numOrUndef(tp.Position?.LatitudeDegrees);
          const lon     = numOrUndef(tp.Position?.LongitudeDegrees);
          const ele     = numOrUndef(tp.AltitudeMeters) ?? 0;

          if (isNaN(time) || lat === undefined || lon === undefined) continue;
          if (firstTimeStr === null && timeStr) firstTimeStr = timeStr;

          // Cumulative distance delta → native per-point distance
          const cumDist = numOrUndef(tp.DistanceMeters);
          let nativeDistance: number | undefined;
          if (cumDist != null && prevCumulativeDist != null) {
            nativeDistance = Math.max(0, cumDist - prevCumulativeDist);
          }
          if (cumDist != null) prevCumulativeDist = cumDist;

          // Extensions: TPX block (after removeNSPrefix: ns3:TPX → TPX)
          const tpx   = tp.Extensions?.TPX ?? {};
          const speed = numOrUndef(tpx.Speed);
          const power = numOrUndef(tpx.Watts) ?? numOrUndef(tpx.Power);

          const pt: RawPoint = {
            lat, lon, ele, time,
            hr:    numOrUndef(tp.HeartRateBpm?.Value),
            cad:   numOrUndef(tp.Cadence),
            pwr:   power,
            speed,
            nativeDistance,
          };

          lapRawPoints.push(pt);
          rawPoints.push(pt);
        }
      }

      // Build native lap entry from TCX lap metadata
      if (!isNaN(lapStartMs) && lapRawPoints.length >= 2) {
        // Compute elevation gain for this lap from its trackpoints
        const lapPhysics = lapRawPoints.map((p, i) => {
          const prev = i > 0 ? lapRawPoints[i - 1] : null;
          const dt   = prev ? (p.time - prev.time) / 1000 : 0;
          return { raw: p, dt, distance: 0, speed: 0, acceleration: 0, vertSpeed: 0, grade: 0, heading: 0, turn: 0 };
        });
        const lapAvgInterval = lapRawPoints.length > 1
          ? (lapRawPoints[lapRawPoints.length - 1].time - lapRawPoints[0].time) / 1000 / (lapRawPoints.length - 1)
          : 1;
        const lapEleGain = accumulateElevation(smoothedElevations(lapPhysics, lapAvgInterval)).gain;

        nativeLaps.push({
          index:         lapIndex++,
          startTime:     lapStartMs,
          endTime:       isNaN(lapEndMs) ? lapRawPoints[lapRawPoints.length - 1].time : lapEndMs,
          distance:      Math.round(lapDist * 100) / 100,
          duration:      Math.round(lapDurS),
          avgSpeed:      Math.round(lapDist / Math.max(lapDurS, 1) * 10000) / 10000,
          avgHeartRate:  lapAvgHR != null ? Math.round(lapAvgHR) : null,
          elevationGain: Math.round(lapEleGain * 100) / 100,
          source:        'device',
        });
      }
    }
  }

  return { rawPoints, nativeLaps, activityName, activityType, creatorName, authorName, firstTimeStr };
}

// ── Parser plugin ─────────────────────────────────────────────────────────────

const TcxParser: Parser = {
  id:          'activity/tcx',
  displayName: 'TCX Activity (Garmin / Suunto / Polar)',

  async canParse(file: FileInput): Promise<boolean> {
    try {
      if (file.name.toLowerCase().endsWith('.tcx')) return true;
      const ab  = await file.slice(0, 512).arrayBuffer();
      const txt = new TextDecoder('utf-8', { fatal: false }).decode(ab);
      return /TrainingCenterDatabase/i.test(txt);
    } catch {
      return false;
    }
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const header = await readHeader(file, 1024);
    const xml    = await file.text();

    const { rawPoints, nativeLaps, activityName, activityType, creatorName, authorName, firstTimeStr }
      = parseTcx(xml);

    if (rawPoints.length === 0) throw new Error('TCX: no valid trackpoints found');

    const { vendor, device } = detectTcxVendor(header, creatorName, authorName);
    const physics = computePhysics(rawPoints);

    const data = assemble(physics, {
      source:       'tcx',
      activityName,
      activityType,
      vendor,
      device,
      // TCX timestamps are always UTC by spec, but derived from device clock (not GPS)
      clockConfidence: 0.9,
      time:         parseTimeMetadata(firstTimeStr),
      laps:         nativeLaps.length > 0 ? nativeLaps : undefined,
    });

    return { kind: 'activity', data };
  },
};

registry.register(TcxParser);

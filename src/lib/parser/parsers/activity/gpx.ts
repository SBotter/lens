/**
 * GPX Activity Parser — universal vendor support
 *
 * Detection: content-based (reads first 512 bytes). Accepts any file whose
 * content begins with a <gpx> element — regardless of file extension.
 *
 * Supported vendors and their extension formats:
 *
 *   Garmin Connect  creator="Garmin Connect"
 *                   <ns3:TrackPointExtension> → hr, cad, atemp, pwr
 *
 *   Wahoo ELEMNT    creator="Wahoo ELEMNT BOLT" (etc.)
 *                   <gpxtpx:TrackPointExtension> → hr, cad, power, atemp
 *
 *   Strava          creator="StravaGPX"
 *                   <extensions><power>…</power></extensions>
 *                   Activity type is numeric ("1"=cycling) — normalized to text
 *
 *   Suunto          creator="Suunto app" / xmlns containing suunto
 *                   <suunto:hr>, <suunto:cadence> (direct children after ns strip)
 *
 *   Polar           creator="Polar Flow"
 *                   <ns3:TrackPointExtension> → hr, cad, speed
 *
 *   COROS           creator="COROS"
 *                   <gpxtpx:TrackPointExtension> → hr, cad
 *
 *   Apple Health    creator="Apple Health Export"
 *                   <extensions><speed> <course> <hAcc> <vAcc></extensions>
 *
 *   Unknown         Any valid GPX 1.1 — GPS-only, no sensors
 */

import { XMLParser }   from 'fast-xml-parser';
import { registry }    from '../../registry';
import type {
  Parser, FileInput, ParseResult, ActivityVendor,
} from '../../types';
import {
  computePhysics, assemble, parseTimeMetadata,
  type RawPoint,
} from './_physics';

// ── Strava numeric activity type map ─────────────────────────────────────────
// https://developers.strava.com/docs/reference/#api-models-ActivityType
const STRAVA_TYPE_MAP: Record<string, string> = {
  '0':  'unknown',        '1':  'cycling',       '2':  'alpine_skiing',
  '3':  'backcountry',    '4':  'canoeing',       '5':  'cross_country_skiing',
  '6':  'crossfit',       '7':  'ebike_ride',     '8':  'elliptical',
  '9':  'golf',           '10': 'handcycle',      '11': 'hike',
  '12': 'ice_skate',      '13': 'inline_skate',   '14': 'kayaking',
  '15': 'kitesurf',       '16': 'nordic_ski',     '17': 'run',
  '18': 'rock_climb',     '19': 'roller_ski',     '20': 'rowing',
  '21': 'snowboard',      '22': 'snowshoe',       '23': 'soccer',
  '24': 'stair_stepper',  '25': 'stand_up_paddle','26': 'surf',
  '27': 'swim',           '28': 'trail_run',      '29': 'velomobile',
  '30': 'virtual_ride',   '31': 'virtual_run',    '32': 'walk',
  '33': 'water_sport',    '34': 'wheelchair',     '35': 'windsurf',
  '36': 'workout',        '37': 'yoga',           '38': 'mountain_bike',
};

function normalizeActivityType(raw: string, vendor: ActivityVendor): string {
  const t = raw.trim();
  if (vendor === 'strava' && /^\d+$/.test(t)) return STRAVA_TYPE_MAP[t] ?? 'unknown';
  return t.toLowerCase().replace(/\s+/g, '_') || 'unknown';
}

// ── Content-based detection ───────────────────────────────────────────────────

async function readHeader(file: FileInput, bytes = 1024): Promise<string> {
  const ab = await file.slice(0, bytes).arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false }).decode(ab);
}

function detectVendor(header: string): { vendor: ActivityVendor; device: string } {
  // Primary: creator attribute is the definitive source.
  // MUST run before full-text search: Wahoo/Strava/Polar files include
  // xmlns:gpxtpx="http://www.garmin.com/xmlschemas/..." which triggers a false
  // garmin match if we search the raw header first.
  const creatorMatch = header.match(/creator\s*=\s*["']([^"']{1,120})["']/i);
  const creator = creatorMatch?.[1] ?? '';
  const cl      = creator.toLowerCase();

  if (cl.includes('wahoo'))                               return { vendor: 'wahoo',  device: creator };
  if (cl.includes('strava'))                              return { vendor: 'strava', device: creator };
  if (cl.includes('garmin'))                              return { vendor: 'garmin', device: creator };
  if (cl.includes('suunto') || cl.includes('movescount')) return { vendor: 'suunto', device: creator };
  if (cl.includes('polar'))                               return { vendor: 'polar',  device: creator };
  if (cl.includes('coros'))                               return { vendor: 'coros',  device: creator };
  if (cl.includes('apple'))                               return { vendor: 'apple',  device: creator };

  // Fallback: strip URLs so schema namespaces don't trigger false positives
  const stripped = header.replace(/https?:\/\/[^\s"'>]+/g, '').toLowerCase();
  if (stripped.includes('apple health') || stripped.includes('apple watch'))
    return { vendor: 'apple',   device: creator || 'Apple Health' };
  if (stripped.includes('garmin'))  return { vendor: 'garmin', device: creator || 'Garmin Connect' };
  if (stripped.includes('strava'))  return { vendor: 'strava', device: creator || 'Strava' };
  if (stripped.includes('wahoo'))   return { vendor: 'wahoo',  device: creator || 'Wahoo ELEMNT' };
  if (stripped.includes('suunto'))  return { vendor: 'suunto', device: creator || 'Suunto' };
  if (stripped.includes('polar'))   return { vendor: 'polar',  device: creator || 'Polar Flow' };
  if (stripped.includes('coros'))   return { vendor: 'coros',  device: creator || 'COROS' };

  return { vendor: 'unknown', device: creator || 'Unknown GPS Device' };
}

// ── XML / sensor parsing ──────────────────────────────────────────────────────

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function numVal(v: unknown): number | undefined {
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

/**
 * Extract sensor fields from a <trkpt><extensions> block.
 *
 * Handles all known vendor formats:
 *   - TrackPointExtension wrapper (Garmin, Wahoo, Polar, COROS)
 *   - Direct children after namespace strip (Suunto, Strava, generic)
 *   - Apple flat extensions (speed, course, hAcc, vAcc)
 */
function extractSensors(ext: unknown): Omit<RawPoint, 'lat' | 'lon' | 'ele' | 'time'> {
  if (!ext || typeof ext !== 'object') return {};
  const e = ext as Record<string, unknown>;

  // Garmin / Wahoo / Polar / COROS: TrackPointExtension wrapper
  // After removeNSPrefix: true, all prefixes (ns3:, gpxtpx:) are stripped
  const tpe = (
    e['TrackPointExtension'] ??
    e['gpxtpx:TrackPointExtension'] ??
    e['ns3:TrackPointExtension']
  ) as Record<string, unknown> | undefined;

  if (tpe) {
    return {
      hr:    numVal(tpe['hr']    ?? tpe['gpxtpx:hr']    ?? tpe['ns3:hr']),
      cad:   numVal(tpe['cad']   ?? tpe['gpxtpx:cad']   ?? tpe['ns3:cad']),
      pwr:   numVal(tpe['pwr']   ?? tpe['power']         ?? tpe['gpxtpx:power']),
      temp:  numVal(tpe['atemp'] ?? tpe['gpxtpx:atemp'] ?? tpe['ns3:atemp']),
      speed: numVal(tpe['speed'] ?? tpe['gpxtpx:speed']),
    };
  }

  // Apple Health: flat extensions — speed, hAcc (no HR)
  if (e['speed'] !== undefined || e['hAcc'] !== undefined || e['vAcc'] !== undefined) {
    return {
      speed: numVal(e['speed']),
      hacc:  numVal(e['hAcc']),
    };
  }

  // Suunto / Strava / generic: direct children after namespace strip
  return {
    hr:    numVal(e['hr']   ?? e['heartrate']),
    cad:   numVal(e['cad']  ?? e['cadence']),
    pwr:   numVal(e['pwr']  ?? e['power']),
    temp:  numVal(e['temp'] ?? e['temperature'] ?? e['atemp']),
    speed: numVal(e['speed']),
  };
}

function parseXml(xml: string, vendor: ActivityVendor): {
  rawPoints:    RawPoint[];
  activityName: string;
  activityType: string;
  firstTimeStr: string | null;
} {
  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    removeNSPrefix:      true,
    isArray: (name) => ['trkpt', 'trkseg', 'trk'].includes(name),
    parseAttributeValue: true,
  });

  const doc = parser.parse(xml);
  const gpx = doc?.gpx ?? doc?.GPX;
  if (!gpx) throw new Error('GPX: no <gpx> root element');

  const tracks = asArray(gpx.trk);
  if (tracks.length === 0) throw new Error('GPX: no <trk> elements');

  const firstTrk    = tracks[0];
  const rawName     = String(firstTrk.name ?? gpx.metadata?.name ?? 'Untitled Activity');
  const rawType     = String(firstTrk.type ?? gpx.metadata?.keywords ?? 'unknown');
  const activityName = rawName;
  const activityType = normalizeActivityType(rawType, vendor);

  const rawPoints: RawPoint[] = [];
  let firstTimeStr: string | null = null;

  for (const trk of tracks) {
    for (const seg of asArray(trk.trkseg)) {
      for (const pt of asArray(seg.trkpt)) {
        const lat     = Number(pt['@_lat']);
        const lon     = Number(pt['@_lon']);
        const ele     = Number(pt.ele ?? 0);
        const timeStr = pt.time ? String(pt.time) : null;
        const time    = timeStr ? new Date(timeStr).getTime() : NaN;

        if (!isFinite(lat) || !isFinite(lon) || isNaN(time)) continue;
        if (firstTimeStr === null && timeStr) firstTimeStr = timeStr;

        const sensors = extractSensors(pt.extensions);
        rawPoints.push({ lat, lon, ele, time, ...sensors });
      }
    }
  }

  return { rawPoints, activityName, activityType, firstTimeStr };
}

// ── Parser plugin ─────────────────────────────────────────────────────────────

const GpxParser: Parser = {
  id:          'activity/gpx',
  displayName: 'GPX Activity (Garmin / Strava / Suunto / Wahoo / Polar / COROS / Apple)',

  async canParse(file: FileInput): Promise<boolean> {
    try {
      const header = await readHeader(file, 512);
      return /<gpx[\s>]/i.test(header);
    } catch {
      return false;
    }
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const header = await readHeader(file, 1024);
    const { vendor, device } = detectVendor(header);

    const xml = await file.text();
    const { rawPoints, activityName, activityType, firstTimeStr } = parseXml(xml, vendor);

    if (rawPoints.length === 0) throw new Error('GPX: no valid track points found');

    const physics  = computePhysics(rawPoints);
    const timeMeta = parseTimeMetadata(firstTimeStr);
    // GPX timestamps come from device clock (not GPS satellite):
    //   Z suffix = clock was set to UTC, high confidence
    //   offset   = local time exported, moderate confidence
    //   none     = ambiguous, low confidence
    const clockConfidence = timeMeta.isUTC
      ? (firstTimeStr?.endsWith('Z') ? 0.9 : 0.8)
      : 0.5;
    const data = assemble(physics, {
      source: 'gpx',
      activityName,
      activityType,
      vendor,
      device,
      clockConfidence,
      time: timeMeta,
    });

    return { kind: 'activity', data };
  },
};

registry.register(GpxParser);

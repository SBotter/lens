/**
 * GPX Activity Parser
 *
 * Supports:
 *   - Garmin GPX (gpxtpx:TrackPointExtension for HR, cadence, power)
 *   - Suunto GPX (suunto:hr, suunto:cadence)
 *   - Generic GPX 1.1
 *
 * Uses fast-xml-parser (pure JS, isomorphic — no DOMParser).
 */

import { XMLParser } from 'fast-xml-parser';
import { registry }  from '../../registry';
import type { Parser, FileInput, ParseResult, ActivityPoint, ActivityMeta } from '../../types';

// ── XML parsing helpers ───────────────────────────────────────────────────────

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

/**
 * Extract sensor values from a <trkpt> extensions block.
 * Handles Garmin gpxtpx:TrackPointExtension and Suunto extensions.
 */
function extractExtensions(ext: Record<string, unknown> | undefined): {
  hr?: number; cad?: number; power?: number;
} {
  if (!ext) return {};

  // Garmin: <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>...</gpxtpx:hr></...>
  // fast-xml-parser strips namespace prefixes with removeNSPrefix: true
  const tpe = (ext['TrackPointExtension'] ?? ext['gpxtpx:TrackPointExtension']) as Record<string, unknown> | undefined;
  if (tpe) {
    return {
      hr:    numOrUndef(tpe['hr']    ?? tpe['gpxtpx:hr']),
      cad:   numOrUndef(tpe['cad']   ?? tpe['gpxtpx:cad']),
      power: numOrUndef(tpe['power'] ?? tpe['gpxtpx:power']),
    };
  }

  // Suunto: direct children of <extensions>
  return {
    hr:  numOrUndef(ext['hr']  ?? ext['suunto:hr']),
    cad: numOrUndef(ext['cad'] ?? ext['suunto:cadence']),
  };
}

// ── Parser implementation ─────────────────────────────────────────────────────

const GpxParser: Parser = {
  id:          'activity/gpx',
  displayName: 'GPX Activity (Garmin / Suunto / generic)',

  canParse(file: FileInput): boolean {
    return file.name.toLowerCase().endsWith('.gpx');
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const xml = await file.text();

    const xmlParser = new XMLParser({
      ignoreAttributes:  false,
      attributeNamePrefix: '@_',
      removeNSPrefix:    true,
      isArray: (name) => ['trkpt', 'trkseg', 'trk'].includes(name),
      parseAttributeValue: true,
    });

    const doc = xmlParser.parse(xml);
    const gpx = doc?.gpx ?? doc?.GPX;
    if (!gpx) throw new Error('GPX: no <gpx> root element found');

    const tracks = asArray(gpx.trk);
    if (tracks.length === 0) throw new Error('GPX: no <trk> elements found');

    // Metadata: creator (device name)
    const deviceName: string = String(
      gpx.metadata?.extensions?.deviceName ??
      gpx['@_creator'] ??
      'Unknown GPS Device'
    );

    const points: ActivityPoint[] = [];
    let hasHR = false, hasCad = false, hasPower = false;

    for (const trk of tracks) {
      for (const seg of asArray(trk.trkseg)) {
        for (const pt of asArray(seg.trkpt)) {
          const lat  = Number(pt['@_lat']);
          const lon  = Number(pt['@_lon']);
          const ele  = Number(pt.ele ?? 0);
          const time = pt.time ? new Date(String(pt.time)).getTime() : NaN;

          if (!isFinite(lat) || !isFinite(lon) || isNaN(time)) continue;

          const sensors = extractExtensions(pt.extensions as Record<string, unknown> | undefined);

          if (sensors.hr    !== undefined) hasHR    = true;
          if (sensors.cad   !== undefined) hasCad   = true;
          if (sensors.power !== undefined) hasPower = true;

          const p: ActivityPoint = { lat, lon, ele, time };
          if (sensors.hr    !== undefined) p.hr    = sensors.hr;
          if (sensors.cad   !== undefined) p.cad   = sensors.cad;
          if (sensors.power !== undefined) p.power = sensors.power;

          points.push(p);
        }
      }
    }

    if (points.length === 0) throw new Error('GPX: no valid track points found');

    const meta: ActivityMeta = {
      sourceFormat: 'gpx',
      deviceName,
      startTime:   points[0].time,
      durationMs:  points[points.length - 1].time - points[0].time,
      pointCount:  points.length,
      sensors:     { hasHR, hasCad, hasPower },
    };

    return { kind: 'activity', points, meta };
  },
};

registry.register(GpxParser);

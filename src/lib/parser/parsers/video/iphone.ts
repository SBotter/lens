/**
 * iPhone MOV Video Parser
 *
 * Extracts timing and optional GPS from iPhone QuickTime MOV files
 * using native binary box parsing (exifr does not support QuickTime brand 'qt  ').
 *
 * Output: two synthetic boundary VideoPoints that define the video time window:
 *   points[0].time = createDateMs         (recording start)
 *   points[1].time = createDateMs + durationMs  (recording end)
 *
 * hasGPS: true if the iPhone had Location Services enabled during recording.
 */

import { registry }         from '../../registry';
import { findMoovContent, findBox, parseMvhd, parseMeta } from './_iphone-moov';
import type { Parser, FileInput, ParseResult, VideoPoint, VideoMeta } from '../../types';

const IPhoneParser: Parser = {
  id:          'iphone-mov',
  displayName: 'iPhone MOV (QuickTime)',

  canParse(file: FileInput): boolean {
    const name = file.name.toLowerCase();
    // iPhone naming convention: IMG_XXXX.MOV or IMG_EXXXX.MOV
    if (/^img_e?\d+\.mov$/.test(name)) return true;
    // Fallback: any .mov file (lower confidence — DJI also uses .mov sometimes)
    return name.endsWith('.mov');
  },

  async parse(file: FileInput): Promise<ParseResult> {
    // ── Locate moov box ────────────────────────────────────────────────────
    const moov = await findMoovContent(file);
    if (!moov) throw new Error('iPhone: no moov box found — invalid or unsupported file');

    // ── Parse mvhd: CreateDate + Duration ─────────────────────────────────
    const mvhdData = findBox(moov, 'mvhd');
    if (!mvhdData) throw new Error('iPhone: mvhd box not found');

    const mvhd = parseMvhd(mvhdData);
    if (!mvhd) throw new Error('iPhone: failed to parse mvhd');

    const { createDateMs, durationMs } = mvhd;

    if (isNaN(createDateMs) || createDateMs < new Date('2000-01-01').getTime()) {
      throw new Error('iPhone: CreateDate is invalid or before year 2000');
    }
    if (durationMs <= 0) {
      throw new Error('iPhone: Duration is zero — file may be incomplete');
    }

    // ── Parse meta: Make, Model, GPS ───────────────────────────────────────
    const meta = parseMeta(moov);

    const startLat = meta.latitude  ?? 0;
    const startLon = meta.longitude ?? 0;
    const hasGPS   = meta.latitude !== undefined && meta.longitude !== undefined &&
                     isFinite(startLat) && isFinite(startLon) &&
                     Math.abs(startLat) > 0.001 && Math.abs(startLon) > 0.001;

    const make  = meta.make.trim();
    const model = meta.model.trim();
    const deviceName = model.toLowerCase().startsWith(make.toLowerCase())
      ? model
      : `${make} ${model}`.trim();

    // ── Build synthetic boundary points ───────────────────────────────────
    const endDateMs = createDateMs + durationMs;
    const points: VideoPoint[] = [
      { lat: startLat, lon: startLon, ele: 0, time: createDateMs },
      { lat: startLat, lon: startLon, ele: 0, time: endDateMs    },
    ];

    const videoMeta: VideoMeta = {
      sourceFormat:     'iphone-mov',
      deviceName,
      startTime:        createDateMs,
      durationMs,
      pointCount:       points.length,
      gpsVideoOffsetMs: 0,
      hasGPS,
    };

    return { kind: 'video', points, meta: videoMeta };
  },
};

registry.register(IPhoneParser);

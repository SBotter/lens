/**
 * Mobile Video Parser — unified catch-all for smartphone recordings
 *
 * Handles:
 *   iPhone      — MOV (QuickTime) and MP4 (HEVC)
 *   Samsung     — Galaxy series MP4
 *   Generic Android — any .mov/.mp4 not claimed by GoPro / Insta360 / DJI
 *
 * Registered last — only receives files no specific parser matched.
 *
 * Device identification:
 *   Apple     → moov/meta/keys/ilst (com.apple.quicktime.make / .model / .location.ISO6709)
 *   Samsung   → udta/auth (display name) + udta/smta (model via 'mdln')
 *   Android   → meta/keys/ilst com.samsung.android.utc_offset (timezone)
 *   Fallback  → udta/©mak + udta/©mod (QuickTime-style tags)
 *
 * Output: two boundary timeline points (start + end) with optional single GPS
 * coordinate for Apple files that embed a recording location.
 *
 * Why binary parsing and not exifr / mp4box:
 *   All phones write moov AFTER mdat. mp4box needs the entire file streamed
 *   sequentially. exifr doesn't read MP4/MOV containers reliably. Direct
 *   binary moov parsing reads only what we need via ranged I/O.
 */

import { findMoovContent, findBox, findAllBoxes, parseMvhd, probeVideoTrack } from './_isobmff';
import { registry } from '../../registry';
import type { Parser, FileInput, ParseResult, VideoJSON, VideoTimelinePoint } from '../../types';

// ── Device metadata extraction ────────────────────────────────────────────────

interface MobileMeta {
  make:       string;
  model:      string;
  deviceName: string;
  latitude?:  number;
  longitude?: number;
  timezone?:  string;
}

/** Return the first run of printable ASCII from a byte buffer. */
function firstPrintableString(d: Uint8Array): string {
  let start = 0;
  while (start < d.length && (d[start] < 0x20 || d[start] > 0x7e)) start++;
  let end = start;
  while (end < d.length && d[end] !== 0 && d[end] >= 0x20) end++;
  return new TextDecoder('utf-8', { fatal: false }).decode(d.subarray(start, end)).trim();
}

/**
 * Extract Samsung model number from udta/smta.
 * The smta box contains sub-entries; 'mdln' is immediately followed by the model string.
 */
function extractSmtaModel(smta: Uint8Array): string | null {
  const mdln = [0x6d, 0x64, 0x6c, 0x6e]; // 'mdln'
  for (let i = 0; i + 4 < smta.length; i++) {
    if (smta[i] === mdln[0] && smta[i+1] === mdln[1] &&
        smta[i+2] === mdln[2] && smta[i+3] === mdln[3]) {
      let end = i + 4;
      while (end < smta.length && smta[end] >= 0x20 && smta[end] <= 0x7e) end++;
      const model = new TextDecoder().decode(smta.subarray(i + 4, end)).trim();
      if (model.length > 0) return model;
    }
  }
  return null;
}

/**
 * Read a meta/keys/ilst block and return make, model, GPS, and/or timezone.
 *
 * Two layouts exist:
 *   - QuickTime MOV (iPhone MOV, Samsung MP4): meta is a regular Box → sub-boxes at offset 0
 *   - ISOBMFF MP4 (iPhone MP4, strict spec): meta is a FullBox → skip 4 bytes (version+flags)
 * We try both offsets automatically.
 *
 * Key namespaces:
 *   Apple   → com.apple.quicktime.make / .model / .location.ISO6709
 *   Android → com.samsung.android.utc_offset / com.android.*
 */
function parseMetaKeys(
  meta: Uint8Array,
): { make?: string; model?: string; latitude?: number; longitude?: number; timezone?: string } {
  const result: { make?: string; model?: string; latitude?: number; longitude?: number; timezone?: string } = {};

  for (const skip of [0, 4]) {
    if (meta.length <= skip) continue;
    const content  = meta.subarray(skip);
    const keysBox  = findBox(content, 'keys');
    const ilstBox  = findBox(content, 'ilst');
    if (!keysBox || !ilstBox || keysBox.length < 8) continue;

    // Build key name list
    const keyCount = (keysBox[4] << 24 | keysBox[5] << 16 | keysBox[6] << 8 | keysBox[7]) >>> 0;
    const keyNames: string[] = [];
    let kpos = 8;
    for (let i = 0; i < keyCount && kpos + 8 <= keysBox.length; i++) {
      const ks = (keysBox[kpos] << 24 | keysBox[kpos+1] << 16 | keysBox[kpos+2] << 8 | keysBox[kpos+3]) >>> 0;
      if (ks < 8 || kpos + ks > keysBox.length) break;
      keyNames.push(new TextDecoder().decode(keysBox.subarray(kpos + 8, kpos + ks)));
      kpos += ks;
    }
    if (keyNames.length === 0) continue;

    // Walk ilst items
    let ipos = 0;
    while (ipos + 8 <= ilstBox.length) {
      const es = (ilstBox[ipos] << 24 | ilstBox[ipos+1] << 16 | ilstBox[ipos+2] << 8 | ilstBox[ipos+3]) >>> 0;
      if (es < 8 || ipos + es > ilstBox.length) break;

      const ki = ((ilstBox[ipos+4] << 24 | ilstBox[ipos+5] << 16 | ilstBox[ipos+6] << 8 | ilstBox[ipos+7]) >>> 0) - 1;
      if (ki >= 0 && ki < keyNames.length && ipos + 24 <= ipos + es) {
        const ds  = (ilstBox[ipos+8]  << 24 | ilstBox[ipos+9]  << 16 | ilstBox[ipos+10] << 8 | ilstBox[ipos+11]) >>> 0;
        const tag = String.fromCharCode(ilstBox[ipos+12], ilstBox[ipos+13], ilstBox[ipos+14], ilstBox[ipos+15]);
        if (tag === 'data') {
          const val = new TextDecoder().decode(
            ilstBox.subarray(ipos + 24, Math.min(ipos + 8 + ds, ipos + es)),
          ).trim();
          const key = keyNames[ki];
          if      (key.endsWith('.make'))             result.make      = val;
          else if (key.endsWith('.model'))            result.model     = val;
          else if (key.endsWith('.location.ISO6709')) {
            const m = val.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
            if (m) { result.latitude = parseFloat(m[1]); result.longitude = parseFloat(m[2]); }
          }
          else if (key.includes('utc_offset'))        result.timezone  = val;
        }
      }
      ipos += es;
    }

    if (result.make || result.model || result.timezone) break;  // found something
  }

  return result;
}

/** Extract all mobile metadata from a raw moov Uint8Array. */
function parseMobileMeta(moov: Uint8Array): MobileMeta {
  const result: MobileMeta = { make: 'Unknown', model: 'Mobile', deviceName: 'Mobile' };

  const udta = findBox(moov, 'udta');

  // ── Samsung / Android path ─────────────────────────────────────────────────
  if (udta) {
    const auth = findBox(udta, 'auth');
    if (auth) {
      const name = firstPrintableString(auth);
      if (name.length > 0) {
        result.deviceName = name;
        result.model      = name;
        if      (/galaxy|samsung/i.test(name))         result.make = 'Samsung';
        else if (/pixel/i.test(name))                  result.make = 'Google';
        else if (/oneplus/i.test(name))                result.make = 'OnePlus';
        else if (/xiaomi|redmi|poco/i.test(name))      result.make = 'Xiaomi';
        else if (/huawei|honor/i.test(name))           result.make = 'Huawei';
        else if (/oppo|realme/i.test(name))            result.make = 'OPPO';
      }
    }

    // Samsung model number from smta/mdln
    const smta = findBox(udta, 'smta');
    if (smta) {
      const smModel = extractSmtaModel(smta);
      if (smModel) result.model = smModel;
    }
  }

  // ── Apple + Android meta/keys/ilst ────────────────────────────────────────
  const metaBox = findBox(moov, 'meta');
  if (metaBox) {
    const keys = parseMetaKeys(metaBox);

    if (keys.make) {
      result.make  = keys.make;
      result.model = keys.model ?? result.model;
      const fullName = result.model.toLowerCase().startsWith(result.make.toLowerCase())
        ? result.model
        : `${result.make} ${result.model}`.trim();
      result.deviceName = fullName;
    }

    if (keys.latitude !== undefined && keys.longitude !== undefined) {
      result.latitude  = keys.latitude;
      result.longitude = keys.longitude;
    }

    if (keys.timezone) result.timezone = keys.timezone;
  }

  // ── Fallback: udta/©mak + udta/©mod (QuickTime-style tags, some Android) ──
  if (result.make === 'Unknown' && udta) {
    const makBox = findAllBoxes(udta, '\xa9mak')[0];
    const modBox = findAllBoxes(udta, '\xa9mod')[0];
    if (makBox) result.make = firstPrintableString(makBox);
    if (modBox) {
      result.model      = firstPrintableString(modBox);
      result.deviceName = result.make !== 'Unknown'
        ? `${result.make} ${result.model}`.trim()
        : result.model;
    }
  }

  return result;
}

// ── Source / stabilization helpers ───────────────────────────────────────────

function detectSource(make: string): string {
  const m = make.toLowerCase();
  if (m.includes('apple'))   return 'iphone';
  if (m.includes('samsung')) return 'samsung';
  if (m.includes('google'))  return 'pixel';
  return 'mobile';
}

function detectStabilization(make: string, model: string): boolean {
  const s = (make + ' ' + model).toLowerCase();
  if (s.includes('apple')  || s.includes('iphone'))  return true;
  if (s.includes('galaxy') || s.includes('samsung')) return true;
  if (s.includes('pixel'))                           return true;
  return false;
}

// ── Parser plugin ─────────────────────────────────────────────────────────────

const MobileParser: Parser = {
  id:          'mobile',
  displayName: 'Mobile (MOV / MP4)',

  canParse(file: FileInput): boolean {
    return /\.(mov|mp4)$/i.test(file.name);
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const moov = await findMoovContent(file);
    if (!moov) throw new Error('Mobile: no moov box found');

    // ── Timing ────────────────────────────────────────────────────────────────
    const mvhdData = findBox(moov, 'mvhd');
    if (!mvhdData) throw new Error('Mobile: mvhd box not found');

    const mvhd = parseMvhd(mvhdData);
    if (!mvhd) throw new Error('Mobile: failed to parse mvhd');

    const { createDateMs, durationMs } = mvhd;

    if (isNaN(createDateMs) || createDateMs < new Date('2000-01-01').getTime()) {
      throw new Error('Mobile: CreateDate is invalid or before year 2000');
    }
    if (durationMs <= 0) {
      throw new Error('Mobile: Duration is zero — file may be incomplete');
    }

    // ── Device + GPS + timezone ───────────────────────────────────────────────
    const meta      = parseMobileMeta(moov);
    const timezone  = meta.timezone ?? 'UTC';
    const container = probeVideoTrack(moov);

    // ── GPS ───────────────────────────────────────────────────────────────────
    const startLat = meta.latitude  ?? 0;
    const startLon = meta.longitude ?? 0;
    const hasGps   = meta.latitude !== undefined && meta.longitude !== undefined &&
                     isFinite(startLat) && isFinite(startLon) &&
                     Math.abs(startLat) > 0.001 && Math.abs(startLon) > 0.001;

    const endTimeUtc = createDateMs + durationMs;
    const durationS  = durationMs / 1000;
    const fps        = container.fps ?? 30;

    // ── Two boundary timeline points ─────────────────────────────────────────
    const timeline: VideoTimelinePoint[] = [
      {
        t: 0, timestamp: createDateMs, fix: 0,
        frame:    { index: 0 },
        position: { lat: startLat, lon: startLon, ele: 0 },
        movement: { speed: 0, gpsSpeed: false },
        sensors:  {},
        quality:  { stability: 1, motionBlur: 0 },
      },
      {
        t: Math.round(durationS * 100) / 100, timestamp: endTimeUtc, fix: 0,
        frame:    { index: Math.round(durationS * fps) },
        position: { lat: startLat, lon: startLon, ele: 0 },
        movement: { speed: 0, gpsSpeed: false },
        sensors:  {},
        quality:  { stability: 1, motionBlur: 0 },
      },
    ];

    const data: VideoJSON = {
      video: {
        metadata: {
          source:       detectSource(meta.make),
          device:       meta.deviceName,
          fileName:     file.name,
          duration:     Math.round(durationS * 100) / 100,
          fps:          container.fps,
          resolution:   container.resolution,
          codec:        container.codec,
          creationTime: createDateMs,
          timezone,
          fileSizeMB:   Math.round((file.size / 1024 / 1024) * 100) / 100,
        },
        time: {
          startTimeUtc:    createDateMs,
          endTimeUtc,
          duration:        Math.round(durationS * 100) / 100,
          clockConfidence: 0.9,
        },
        spatial: {
          hasGps,
          boundingBox: hasGps
            ? { minLat: startLat, maxLat: startLat, minLon: startLon, maxLon: startLon }
            : null,
        },
        timeline,
        segments: [],
        features: {
          hasGps,
          hasAccelerometer: false,
          hasGyro:          false,
          hasAudio:         container.hasAudio,
          hasStabilization: detectStabilization(meta.make, meta.model),
        },
        alignmentHints: {
          hasAbsoluteTime: true,
          hasGpsTrack:     hasGps,
          gpsLockOffsetMs: 0,
          syncScore:       hasGps ? 0.7 : 0.5,
        },
        quality: {
          overallScore:   0.6,
          stabilityScore: 0.8,
          gpsQuality:     hasGps ? 0.5 : 0,
        },
      },
    };

    return { kind: 'video', data };
  },
};

registry.register(MobileParser);

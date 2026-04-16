/**
 * MP4 / QuickTime binary parsing helpers.
 *
 * Originally for iPhone MOV; extended to cover all ISOBMFF/QuickTime files
 * (GoPro MP4, Samsung Galaxy MP4, iPhone MP4, etc.).
 *
 * All functions use only Uint8Array + ArrayBuffer — fully isomorphic (browser + Node.js).
 * The FileInput.slice() call is the only I/O boundary.
 *
 * Key exports:
 *   findMoovContent   — ranged read of moov regardless of file layout
 *   findBox / findAllBoxes — box tree traversal
 *   parseMvhd         — creation time + duration (Mac epoch → Unix)
 *   parseMeta         — Apple QuickTime make/model/GPS from meta/keys/ilst
 *   probeVideoTrack   — fps / resolution / codec / hasAudio from moov binary
 */

import type { FileInput } from '../../types';

// ── Binary primitives ─────────────────────────────────────────────────────────

/** Read big-endian uint32 */
export function u32(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

/** Read big-endian uint64 as JS number (safe up to 2^53 — fine for timestamps) */
export function u64(d: Uint8Array, o: number): number {
  return u32(d, o) * 4294967296 + u32(d, o + 4);
}

/** Read 4-char box type at offset */
export function fourcc(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
}

// ── Box traversal ─────────────────────────────────────────────────────────────

/**
 * Find first box of given 4-char type within a Uint8Array.
 * Returns box content (data after header), or null.
 * Scans sequentially at the given level — does not recurse.
 */
export function findBox(d: Uint8Array, type: string, startPos = 0): Uint8Array | null {
  let pos = startPos;
  const LIMIT = 256;
  for (let i = 0; i < LIMIT && pos + 8 <= d.length; i++) {
    const size32 = u32(d, pos);
    const t      = fourcc(d, pos + 4);

    let totalSize: number;
    let hdrSize:   number;

    if (size32 === 1 && pos + 16 <= d.length) {
      totalSize = u64(d, pos + 8);
      hdrSize   = 16;
    } else if (size32 === 0) {
      totalSize = d.length - pos;
      hdrSize   = 8;
    } else {
      totalSize = size32;
      hdrSize   = 8;
    }

    if (totalSize < 8) break;

    if (t === type) {
      const end = Math.min(pos + hdrSize + (totalSize - hdrSize), d.length);
      return d.subarray(pos + hdrSize, end);
    }

    pos += totalSize;
  }
  return null;
}

// ── Moov locator ─────────────────────────────────────────────────────────────

/**
 * Navigate top-level box tree and return the full moov content.
 *
 * iPhone MOV layout: ftyp → wide → mdat (hundreds of MB) → moov (~150 KB)
 * We read only 16-byte headers to navigate; total I/O before moov ≈ 64 bytes.
 *
 * @param maxBytes  Safety cap on moov read size (default 12 MB)
 */
export async function findMoovContent(
  file: FileInput,
  maxBytes = 12 * 1024 * 1024,
): Promise<Uint8Array | null> {
  let pos = 0;
  const MAX_BOXES = 64;

  for (let i = 0; i < MAX_BOXES && pos < file.size; i++) {
    const hdrLen = Math.min(16, file.size - pos);
    const hdrBuf = await file.slice(pos, pos + hdrLen).arrayBuffer();
    const hdr    = new Uint8Array(hdrBuf);
    if (hdr.length < 8) break;

    const size32 = u32(hdr, 0);
    const type   = fourcc(hdr, 4);

    let boxSize: number;
    let hdrSize: number;

    if (size32 === 1 && hdr.length >= 16) {
      boxSize = u64(hdr, 8);
      hdrSize = 16;
    } else if (size32 === 0) {
      boxSize = file.size - pos;
      hdrSize = 8;
    } else {
      boxSize = size32;
      hdrSize = 8;
    }

    if (boxSize < 8) break;

    if (type === 'moov') {
      const readSize = Math.min(boxSize - hdrSize, maxBytes);
      const buf = await file.slice(pos + hdrSize, pos + hdrSize + readSize).arrayBuffer();
      return new Uint8Array(buf);
    }

    pos += boxSize;
  }
  return null;
}

// ── mvhd parser ───────────────────────────────────────────────────────────────

/** Seconds from Mac epoch (1904-01-01) to Unix epoch (1970-01-01) */
const MAC_TO_UNIX_S = 2082844800;

export interface MvhdResult {
  createDateMs: number;
  durationMs:   number;
}

/**
 * Parse the Movie Header Box (mvhd).
 * version 0: 32-bit creation_time, modification_time, timescale, duration
 * version 1: 64-bit creation_time, modification_time; 32-bit timescale; 64-bit duration
 */
export function parseMvhd(d: Uint8Array): MvhdResult | null {
  if (d.length < 20) return null;
  const version = d[0];

  if (version === 1) {
    if (d.length < 32) return null;
    const createSec = u64(d, 4) - MAC_TO_UNIX_S;
    const timescale = u32(d, 20);
    const dur       = u64(d, 24);
    return {
      createDateMs: createSec * 1000,
      durationMs:   timescale > 0 ? Math.round(dur / timescale * 1000) : 0,
    };
  }

  // version 0 (default for iPhone)
  const createSec = u32(d, 4) - MAC_TO_UNIX_S;
  const timescale = u32(d, 12);
  const dur       = u32(d, 16);
  return {
    createDateMs: createSec * 1000,
    durationMs:   timescale > 0 ? Math.round(dur / timescale * 1000) : 0,
  };
}

// ── meta/keys/ilst parser ────────────────────────────────────────────────────

export interface MetaResult {
  make:       string;
  model:      string;
  latitude?:  number;
  longitude?: number;
}

/**
 * Parse Apple QuickTime metadata (moov/meta) for make, model, and GPS.
 *
 * iPhone meta box structure:
 *   hdlr  — declares 'mdta' handler
 *   keys  — array of com.apple.quicktime.* key names
 *   ilst  — values indexed by 1-based key position
 */
export function parseMeta(moov: Uint8Array): MetaResult {
  const result: MetaResult = { make: 'Apple', model: 'iPhone' };

  const meta = findBox(moov, 'meta');
  if (!meta) return result;

  const keysBox = findBox(meta, 'keys');
  const ilstBox = findBox(meta, 'ilst');
  if (!keysBox || !ilstBox) return result;

  if (keysBox.length < 8) return result;
  const keyCount = u32(keysBox, 4);
  const keyNames: string[] = [];

  let kpos = 8;
  for (let i = 0; i < keyCount && kpos + 8 <= keysBox.length; i++) {
    const ks = u32(keysBox, kpos);
    if (ks < 8 || kpos + ks > keysBox.length) break;
    const keyStr = new TextDecoder().decode(keysBox.subarray(kpos + 8, kpos + ks));
    keyNames.push(keyStr);
    kpos += ks;
  }

  let ipos = 0;
  while (ipos + 8 <= ilstBox.length) {
    const entrySize = u32(ilstBox, ipos);
    if (entrySize < 8 || ipos + entrySize > ilstBox.length) break;

    const keyIndex0 = u32(ilstBox, ipos + 4) - 1;

    if (keyIndex0 >= 0 && keyIndex0 < keyNames.length && ipos + 24 <= ipos + entrySize) {
      const dataSize = u32(ilstBox, ipos + 8);
      const dataTag  = fourcc(ilstBox, ipos + 12);
      if (dataTag === 'data') {
        const val = new TextDecoder().decode(
          ilstBox.subarray(ipos + 24, Math.min(ipos + 8 + dataSize, ilstBox.length)),
        );
        const key = keyNames[keyIndex0];

        if      (key.endsWith('.make'))             result.make  = val.trim() || result.make;
        else if (key.endsWith('.model'))            result.model = val.trim() || result.model;
        else if (key.endsWith('.location.ISO6709')) {
          const m = val.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
          if (m) {
            result.latitude  = parseFloat(m[1]);
            result.longitude = parseFloat(m[2]);
          }
        }
      }
    }

    ipos += entrySize;
  }

  return result;
}

// ── Multi-box scanner ────────────────────────────────────────────────────────

/**
 * Collect all immediate child boxes of a given type from a flat Uint8Array.
 * Returns an array of box content buffers (header stripped).
 */
export function findAllBoxes(d: Uint8Array, type: string): Uint8Array[] {
  const results: Uint8Array[] = [];
  let pos = 0;
  while (pos + 8 <= d.length) {
    const size32 = u32(d, pos);
    const t      = fourcc(d, pos + 4);
    let totalSize = size32;
    let hdrSize   = 8;
    if (size32 === 1 && pos + 16 <= d.length) {
      totalSize = u64(d, pos + 8);
      hdrSize   = 16;
    } else if (size32 === 0) {
      totalSize = d.length - pos;
    }
    if (totalSize < 8) break;
    if (t === type) {
      results.push(d.subarray(pos + hdrSize, Math.min(pos + totalSize, d.length)));
    }
    pos += totalSize;
  }
  return results;
}

// ── Video track probe ─────────────────────────────────────────────────────────

export interface ContainerInfo {
  fps:        number | null;
  resolution: string | null;
  codec:      string | null;
  durationMs: number | null;
  hasAudio:   boolean;
}

function resolveResolution(w: number, h: number): string {
  if (w >= 3840) return '4K';
  if (w >= 2704) return '2.7K';
  if (w >= 1920) return '1080p';
  if (w >= 1280) return '720p';
  return `${w}x${h}`;
}

function resolveCodec(tag: string): string {
  const c = tag.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('avc ')) return 'H.264';
  if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'H.265';
  if (c.startsWith('vp08'))                          return 'VP8';
  if (c.startsWith('vp09'))                          return 'VP9';
  if (c.startsWith('av01'))                          return 'AV1';
  return tag;
}

/**
 * Extract fps / resolution / codec / hasAudio / durationMs from raw moov bytes.
 *
 * Traversal:
 *   moov/mvhd           → durationMs (fallback)
 *   moov/trak[]/mdia/hdlr → identifies video ('vide') and audio ('soun') tracks
 *   moov/trak/tkhd       → width × height (16.16 fixed-point)
 *   moov/trak/mdia/mdhd  → timescale
 *   moov/trak/mdia/minf/stbl/stts → sample delta → fps
 *   moov/trak/mdia/minf/stbl/stsd → codec fourcc
 */
export function probeVideoTrack(moov: Uint8Array): ContainerInfo {
  // mvhd fallback duration
  let durationMs: number | null = null;
  const mvhd = findBox(moov, 'mvhd');
  if (mvhd && mvhd.length >= 20) {
    const ver = mvhd[0];
    if (ver === 0) {
      const ts = u32(mvhd, 12);
      const dur = u32(mvhd, 16);
      if (ts > 0) durationMs = Math.round((dur / ts) * 1000);
    } else if (ver === 1 && mvhd.length >= 32) {
      const ts  = u32(mvhd, 20);
      const dur = u64(mvhd, 24);
      if (ts > 0) durationMs = Math.round((dur / ts) * 1000);
    }
  }

  let fps: number | null = null;
  let resolution: string | null = null;
  let codec: string | null = null;
  let hasAudio = false;

  const traks = findAllBoxes(moov, 'trak');

  // First pass: detect audio
  for (const trak of traks) {
    const mdia = findBox(trak, 'mdia');
    if (!mdia) continue;
    const hdlr = findBox(mdia, 'hdlr');
    if (hdlr && hdlr.length >= 12 && fourcc(hdlr, 8) === 'soun') {
      hasAudio = true;
      break;
    }
  }

  // Second pass: extract video track info
  for (const trak of traks) {
    const mdia = findBox(trak, 'mdia');
    if (!mdia) continue;
    const hdlr = findBox(mdia, 'hdlr');
    if (!hdlr || hdlr.length < 12 || fourcc(hdlr, 8) !== 'vide') continue;

    // tkhd: resolution (width × height as 16.16 fixed-point)
    // v0 offset 76, v1 offset 88
    const tkhd = findBox(trak, 'tkhd');
    if (tkhd) {
      const wOff = tkhd[0] === 1 ? 88 : 76;
      if (tkhd.length >= wOff + 8) {
        const w = u32(tkhd, wOff) >>> 16;
        const h = u32(tkhd, wOff + 4) >>> 16;
        if (w > 0 && h > 0) resolution = resolveResolution(w, h);
      }
    }

    // mdhd: media timescale
    const mdhd = findBox(mdia, 'mdhd');
    let mediaTimescale = 90000;
    if (mdhd && mdhd.length >= 20) {
      mediaTimescale = mdhd[0] === 1 ? u32(mdhd, 20) : u32(mdhd, 12);
    }

    const minf = findBox(mdia, 'minf');
    if (minf) {
      const stbl = findBox(minf, 'stbl');
      if (stbl) {
        // stts: version(1)+flags(3)+entry_count(4)+[sample_count(4)+sample_delta(4)…]
        const stts = findBox(stbl, 'stts');
        if (stts && stts.length >= 16) {
          const delta = u32(stts, 12);  // first entry's sample_delta
          if (delta > 0 && mediaTimescale > 0) {
            fps = Math.round((mediaTimescale / delta) * 10) / 10;
          }
        }

        // stsd: version(1)+flags(3)+entry_count(4)+[size(4)+codec(4)…]
        const stsd = findBox(stbl, 'stsd');
        if (stsd && stsd.length >= 16) {
          codec = resolveCodec(fourcc(stsd, 12));
        }
      }
    }

    break;  // first video track is enough
  }

  return { fps, resolution, codec, durationMs, hasAudio };
}

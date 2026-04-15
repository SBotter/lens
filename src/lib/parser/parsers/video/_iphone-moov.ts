/**
 * iPhone QuickTime binary parsing helpers.
 *
 * These functions parse the ISOBMFF/QuickTime container to extract:
 *   - CreateDate (UTC) and Duration from the mvhd box
 *   - Make, Model, and optional GPS from the meta/keys/ilst boxes
 *
 * Ported from prorefuel-poc/src/lib/workers/iphone.worker.ts.
 * All functions use only Uint8Array + ArrayBuffer — fully isomorphic (browser + Node.js).
 * The FileInput.slice() call is the only I/O boundary.
 *
 * Why native parsing and not exifr:
 *   exifr 7.x does not support QuickTime brand ('qt  ') files.
 *   All iPhone cameras record pure QuickTime MOV — not MPEG-4/MP4.
 *   exifr throws "Unknown file format" on every iPhone MOV.
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

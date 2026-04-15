/**
 * Insta360 MP4 Video Parser — Phase 1 Stub
 *
 * Phase 1: extracts container metadata (duration, device name) via mp4box.
 * GPS telemetry extraction will be added in Phase 2 when the Insta360
 * proprietary CAMM/custom box format is implemented.
 *
 * Insta360 filename patterns: VID_XXXX, LRV_XXXX, PRO_XXXX
 */

import * as MP4Box from 'mp4box';
import { registry } from '../../registry';
import type { Parser, FileInput, ParseResult, VideoMeta } from '../../types';

const INSTA360_RE = /^(VID_|LRV_|PRO_|Insta360)/i;

const Insta360Parser: Parser = {
  id:          'insta360-mp4',
  displayName: 'Insta360 (MP4 — stub)',

  canParse(file: FileInput): boolean {
    const name = file.name.toLowerCase();
    if (!/\.mp4$/.test(name)) return false;
    return INSTA360_RE.test(file.name);
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const { duration, creationTime } = await probeMp4(file);

    const meta: VideoMeta = {
      sourceFormat:     'insta360-mp4',
      deviceName:       'Insta360',
      startTime:        creationTime ?? 0,
      durationMs:       duration ?? 0,
      pointCount:       0,
      gpsVideoOffsetMs: 0,
      hasGPS:           false,
    };

    // Phase 1: no GPS extraction yet
    console.warn('[Insta360] GPS telemetry extraction not yet implemented (Phase 1 stub)');
    return { kind: 'video', points: [], meta };
  },
};

/** Use mp4box to probe container timing without full parse. */
async function probeMp4(
  file: FileInput,
): Promise<{ duration?: number; creationTime?: number }> {
  return new Promise((resolve) => {
    const mp4 = MP4Box.createFile();
    let resolved = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mp4.onReady = (info: any) => {
      if (resolved) return;
      resolved = true;
      const durationS = Number(info.duration);
      const ts        = Number(info.timescale);
      const creation  = info.created instanceof Date
        ? info.created.getTime()
        : undefined;
      resolve({
        duration:     ts > 0 ? Math.round(durationS / ts * 1000) : undefined,
        creationTime: creation,
      });
    };

    mp4.onError = () => { if (!resolved) { resolved = true; resolve({}); } };

    // Feed only the first 512 KB — enough for ftyp + moov header
    file.slice(0, 512 * 1024).arrayBuffer().then((ab) => {
      (ab as any).fileStart = 0;
      mp4.appendBuffer(ab as ArrayBuffer & { fileStart: number });
      mp4.flush();
      // Resolve with empty if onReady didn't fire
      setTimeout(() => { if (!resolved) { resolved = true; resolve({}); } }, 3000);
    }).catch(() => resolve({}));
  });
}

registry.register(Insta360Parser);

/**
 * DJI MP4 Video Parser — Phase 1 Stub
 *
 * Phase 1: extracts container metadata (duration, device name) via mp4box.
 * GPS telemetry extraction using DJI's CAMM (Camera Motion Metadata Spec)
 * will be added in Phase 2.
 *
 * DJI filename patterns: DJI_XXXX, DJI-XXXXXX
 */

import * as MP4Box from 'mp4box';
import { registry } from '../../registry';
import type { Parser, FileInput, ParseResult, VideoMeta } from '../../types';

const DJI_RE = /^DJI[_\-]/i;

const DjiParser: Parser = {
  id:          'dji-mp4',
  displayName: 'DJI (MP4 — stub)',

  canParse(file: FileInput): boolean {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.mp4')) return false;
    return DJI_RE.test(file.name);
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const { duration, creationTime, deviceName } = await probeDjiMp4(file);

    const meta: VideoMeta = {
      sourceFormat:     'dji-mp4',
      deviceName:       deviceName ?? 'DJI',
      startTime:        creationTime ?? 0,
      durationMs:       duration ?? 0,
      pointCount:       0,
      gpsVideoOffsetMs: 0,
      hasGPS:           false,
    };

    console.warn('[DJI] GPS telemetry extraction not yet implemented (Phase 1 stub)');
    return { kind: 'video', points: [], meta };
  },
};

async function probeDjiMp4(
  file: FileInput,
): Promise<{ duration?: number; creationTime?: number; deviceName?: string }> {
  return new Promise((resolve) => {
    const mp4 = MP4Box.createFile();
    let resolved = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mp4.onReady = (info: any) => {
      if (resolved) return;
      resolved = true;
      const durationS = Number(info.duration);
      const ts        = Number(info.timescale);
      const creation  = info.created instanceof Date ? info.created.getTime() : undefined;
      // DJI embeds the drone model in the movie fragment comment
      const brands    = (info.compatible_brands as string[] | undefined) ?? [];
      const deviceName = brands.find(b => b.toLowerCase().includes('dji'));
      resolve({
        duration:     ts > 0 ? Math.round(durationS / ts * 1000) : undefined,
        creationTime: creation,
        deviceName,
      });
    };

    mp4.onError = () => { if (!resolved) { resolved = true; resolve({}); } };

    file.slice(0, 512 * 1024).arrayBuffer().then((ab) => {
      (ab as any).fileStart = 0;
      mp4.appendBuffer(ab as ArrayBuffer & { fileStart: number });
      mp4.flush();
      setTimeout(() => { if (!resolved) { resolved = true; resolve({}); } }, 3000);
    }).catch(() => resolve({}));
  });
}

registry.register(DjiParser);

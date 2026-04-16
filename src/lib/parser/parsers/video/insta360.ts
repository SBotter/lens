/**
 * Insta360 MP4 Video Parser — Phase 1
 *
 * Extracts container metadata (fps, resolution, codec, duration, creation time).
 * GPS telemetry via Insta360 proprietary format — Phase 2.
 */

import { findMoovContent, findBox, parseMvhd, probeVideoTrack } from './_isobmff';
import { registry } from '../../registry';
import type { Parser, FileInput, ParseResult, VideoJSON } from '../../types';

const INSTA360_RE = /^(VID_|LRV_|PRO_|Insta360)/i;

const Insta360Parser: Parser = {
  id:          'insta360-mp4',
  displayName: 'Insta360 (MP4)',

  canParse(file: FileInput): boolean {
    const name = file.name.toLowerCase();
    if (!/\.mp4$/.test(name)) return false;
    return INSTA360_RE.test(file.name);
  },

  async parse(file: FileInput): Promise<ParseResult> {
    const moov = await findMoovContent(file);

    let durationMs  = 0;
    let creationTime = 0;
    let container   = { fps: null as number | null, resolution: null as string | null, codec: null as string | null, hasAudio: false, durationMs: null as number | null };

    if (moov) {
      const mvhdData = findBox(moov, 'mvhd');
      if (mvhdData) {
        const mvhd = parseMvhd(mvhdData);
        if (mvhd) {
          durationMs   = mvhd.durationMs;
          creationTime = mvhd.createDateMs;
        }
      }
      container = probeVideoTrack(moov);
      if (container.durationMs != null) durationMs = container.durationMs;
    }

    const durationS = durationMs / 1000;

    const data: VideoJSON = {
      video: {
        metadata: {
          source:       'insta360',
          device:       'Insta360',
          fileName:     file.name,
          duration:     Math.round(durationS * 100) / 100,
          fps:          container.fps,
          resolution:   container.resolution,
          codec:        container.codec,
          creationTime,
          timezone:     'UTC',
          fileSizeMB:   Math.round((file.size / 1024 / 1024) * 100) / 100,
        },
        time: {
          startTimeUtc:    creationTime,
          endTimeUtc:      creationTime + durationMs,
          duration:        Math.round(durationS * 100) / 100,
          clockConfidence: 0.8,
        },
        spatial:        { hasGps: false, boundingBox: null },
        timeline:       [],
        segments:       [],
        features:       { hasGps: false, hasAccelerometer: false, hasGyro: false, hasAudio: container.hasAudio, hasStabilization: true },
        alignmentHints: { hasAbsoluteTime: creationTime > 0, hasGpsTrack: false, gpsLockOffsetMs: 0, syncScore: 0.3 },
        quality:        { overallScore: 0.3, stabilityScore: 0, gpsQuality: 0 },
      },
    };

    return { kind: 'video', data };
  },
};

registry.register(Insta360Parser);

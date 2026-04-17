/**
 * Sync layer public API.
 *
 * Usage:
 *   import { buildSession, buildRenderManifest, defaultRules } from '@/lib/sync';
 *
 *   const session  = buildSession(activityJSON, [videoJSON], defaultRules);
 *   const manifest = buildRenderManifest(session);
 *
 * Rules override example:
 *   const session = buildSession(activity, videos, {
 *     ...defaultRules,
 *     sync: { ...defaultRules.sync, spatialThresholdM: 150 },
 *   });
 */

import rawRules from './default-rules.json';
import type { RulesConfig } from './types';

export const defaultRules: RulesConfig = rawRules as RulesConfig;

export { buildSession }          from './SessionBuilder';
export { buildRenderManifest }   from './RenderManifestBuilder';
export { selectVideoHighlights } from './VideoHighlightSelector';

export type {
  SessionJSON,
  RenderManifest,
  RenderClip,
  RenderFrame,
  HighlightCandidate,
  VideoSyncResult,
  VideoMeta,
  ConflictRecord,
  QualityReport,
  RulesConfig,
  SceneType,
  RenderMode,
  TransitionType,
} from './types';

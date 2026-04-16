/**
 * Parser registry entry point.
 *
 * Importing this module registers ALL device parsers into the singleton registry.
 * Use this in both the browser app and the CLI — they share the same parser code.
 *
 * ── Adding a new device ───────────────────────────────────────────────────────
 * 1. Create src/lib/parser/parsers/{activity|video}/your-device.ts
 * 2. Implement the Parser interface and call registry.register(YourParser) at module level
 * 3. Add one import line below — that's it
 */

// ── Activity parsers ──────────────────────────────────────────────────────────
import './parsers/activity/gpx';
import './parsers/activity/tcx';
import './parsers/activity/fit';

// ── Video parsers ─────────────────────────────────────────────────────────────
import './parsers/video/gopro';
import './parsers/video/insta360';
import './parsers/video/dji';
import './parsers/video/mobile';  // catch-all for .mov/.mp4 — must be last

// ── Exports ───────────────────────────────────────────────────────────────────
export { registry }                             from './registry';
export type { ParseResult, ActivityJSON, VideoJSON, ActivityMetadata, FileInput, Parser } from './types';

#!/usr/bin/env tsx
/**
 * Lens Parser CLI — stress-test harness for the production parser.
 *
 * Reads all files from a session folder, detects device per file,
 * parses them using the EXACT same parser code as the browser app,
 * and writes JSON output to <session>/json/
 *
 * Usage:
 *   npm run parse -- --input ./Input/session1
 *   npm run parse -- --input ./Input/session1 --verbose
 *
 * Output:
 *   ./Input/session1/json/activity.json
 *   ./Input/session1/json/video.json
 */

import path from 'node:path';
import fs   from 'node:fs/promises';

// Import parser registry — registers all device parsers at module load time
import { registry } from '../lib/parser/index';
import { NodeFileAdapter } from '../lib/parser/NodeFileAdapter';
import type { ParseResult } from '../lib/parser/types';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const inputIdx = args.indexOf('--input');
const verbose  = args.includes('--verbose') || args.includes('-v');

if (inputIdx === -1 || !args[inputIdx + 1]) {
  console.error('Usage: npm run parse -- --input <session-folder> [--verbose]');
  console.error('Example: npm run parse -- --input ./Input/session1');
  process.exit(1);
}

const sessionDir = path.resolve(args[inputIdx + 1]);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify the session directory exists
  try {
    const stat = await fs.stat(sessionDir);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`Error: "${sessionDir}" does not exist or is not a directory.`);
    process.exit(1);
  }

  console.log(`\nLens Parser`);
  console.log(`Session: ${sessionDir}`);
  console.log(`Registered parsers: ${registry.list().map(p => p.id).join(', ')}\n`);

  // List files in session directory (skip hidden files and the json/ output folder)
  const entries = await fs.readdir(sessionDir, { withFileTypes: true });
  const files   = entries.filter(e =>
    e.isFile() &&
    !e.name.startsWith('.') &&
    !e.name.startsWith('~'),
  );

  if (files.length === 0) {
    console.warn(`No files found in ${sessionDir}`);
    process.exit(0);
  }

  // ── Parse each file ───────────────────────────────────────────────────────
  const activityResults: ParseResult[] = [];
  const videoResults:    ParseResult[] = [];
  const skipped:         string[]      = [];
  const failed:          { name: string; error: string }[] = [];

  for (const entry of files) {
    const filePath = path.join(sessionDir, entry.name);
    const adapter  = await NodeFileAdapter.fromPath(filePath);

    // Find the correct parser
    const parser = await registry.resolve(adapter);
    if (!parser) {
      console.warn(`  [SKIP] ${entry.name} — no parser matched`);
      skipped.push(entry.name);
      continue;
    }

    console.log(`  [PARSE] ${entry.name} → ${parser.displayName}`);

    try {
      const result = await parser.parse(adapter);

      if (verbose) {
        console.log(`    kind:       ${result.kind}`);
        console.log(`    points:     ${result.points.length}`);
        console.log(`    device:     ${result.meta.deviceName}`);
        console.log(`    startTime:  ${new Date(result.meta.startTime).toISOString()}`);
        console.log(`    durationMs: ${result.meta.durationMs}`);
      }

      if (result.kind === 'activity') activityResults.push(result);
      else                            videoResults.push(result);

    } catch (err: unknown) {
      const msg = (err instanceof Error) ? err.message : String(err);
      console.error(`  [ERROR] ${entry.name}: ${msg}`);
      failed.push({ name: entry.name, error: msg });
    }
  }

  // ── Write JSON output ─────────────────────────────────────────────────────
  const outDir = path.join(sessionDir, 'json');
  await fs.mkdir(outDir, { recursive: true });

  let wrote = 0;

  if (activityResults.length > 0) {
    const outPath = path.join(outDir, 'activity.json');
    const payload = activityResults.length === 1 ? activityResults[0] : activityResults;
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`\n  [OUT] activity.json — ${activityResults.reduce((s, r) => s + r.points.length, 0)} points`);
    wrote++;
  }

  if (videoResults.length > 0) {
    const outPath = path.join(outDir, 'video.json');
    const payload = videoResults.length === 1 ? videoResults[0] : videoResults;
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`  [OUT] video.json    — ${videoResults.reduce((s, r) => s + r.points.length, 0)} points`);
    wrote++;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────');
  console.log(`Parsed:  ${activityResults.length + videoResults.length} file(s)`);
  if (skipped.length) console.log(`Skipped: ${skipped.length} file(s) — ${skipped.join(', ')}`);
  if (failed.length)  console.log(`Failed:  ${failed.length} file(s) — ${failed.map(f => f.name).join(', ')}`);
  if (wrote)          console.log(`Output:  ${outDir}/`);
  console.log('─────────────────────────────────────────\n');

  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});

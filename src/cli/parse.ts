#!/usr/bin/env tsx
/**
 * Lens Parser CLI — stress-test harness for the production parser.
 *
 * Reads all files from a session folder, detects device per file,
 * parses them using the EXACT same parser code as the browser app,
 * and writes JSON output to <session>/json/
 *
 * Usage:
 *   npm run parse -- ./Input/session1
 *
 * Output:
 *   ./Input/session1/json/activity.json
 *   ./Input/session1/json/video.json
 */

import path from 'node:path';
import fs   from 'node:fs/promises';

import { registry }      from '../lib/parser/index';
import { NodeFileAdapter } from '../lib/parser/NodeFileAdapter';
import type { ParseResult } from '../lib/parser/types';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
// First non-flag argument is the session folder
const sessionArg = args.find(a => !a.startsWith('-'));

if (!sessionArg) {
  console.error('Usage: npm run parse -- <session-folder>');
  console.error('Example: npm run parse -- ./Input/gpx/garmin');
  process.exit(1);
}

const sessionDir = path.resolve(sessionArg);

// ── Verbose summary for a parsed result ──────────────────────────────────────

function logVerbose(result: ParseResult): void {
  if (result.kind === 'activity') {
    const { metadata, summary, timeline, laps, quality } = result.data.activity;
    console.log(`    vendor:      ${metadata.vendor} / ${metadata.device}`);
    console.log(`    activity:    ${metadata.activityName} (${metadata.activityType})`);
    console.log(`    startTime:   ${new Date(metadata.startTime).toISOString()}`);
    console.log(`    totalTime:   ${metadata.totalTime}s  movingTime: ${metadata.movingTime}s`);
    console.log(`    distance:    ${(summary.totalDistance / 1000).toFixed(2)} km`);
    console.log(`    elevation:   +${summary.elevationGain.toFixed(0)}m / -${summary.elevationLoss.toFixed(0)}m`);
    console.log(`    avgSpeed:    ${(summary.avgSpeed * 3.6).toFixed(1)} km/h  max: ${(summary.maxSpeed * 3.6).toFixed(1)} km/h`);
    if (summary.avgHeartRate) console.log(`    HR:          avg ${summary.avgHeartRate} / max ${summary.maxHeartRate} bpm`);
    console.log(`    stops:       ${summary.stops}  (${summary.totalStopTime}s)`);
    console.log(`    laps:        ${laps.length}`);
    console.log(`    points:      ${timeline.length}`);
    console.log(`    quality:     ${(quality.overallScore * 100).toFixed(0)}%  gps: ${(quality.gpsQuality.signalConsistency * 100).toFixed(0)}%`);
  } else {
    const v = result.data.video;
    console.log(`    device:     ${v.metadata.device}`);
    console.log(`    fileName:   ${v.metadata.fileName}`);
    console.log(`    duration:   ${v.metadata.duration}s  fps: ${v.metadata.fps ?? '?'}  res: ${v.metadata.resolution ?? '?'}`);
    console.log(`    startTime:  ${new Date(v.time.startTimeUtc).toISOString()}`);
    console.log(`    points:     ${v.timeline.length}  segments: ${v.segments.length}`);
    console.log(`    gpsLock:    ${v.alignmentHints.gpsLockOffsetMs}ms offset  syncScore: ${v.alignmentHints.syncScore}`);
    console.log(`    features:   gps=${v.features.hasGps} gyro=${v.features.hasGyro} audio=${v.features.hasAudio} stabilization=${v.features.hasStabilization}`);
    console.log(`    quality:    overall=${(v.quality.overallScore*100).toFixed(0)}%  gps=${(v.quality.gpsQuality*100).toFixed(0)}%  stability=${(v.quality.stabilityScore*100).toFixed(0)}%`);
  }
}

// ── Point count helper ────────────────────────────────────────────────────────

function pointCount(result: ParseResult): number {
  if (result.kind === 'activity') return result.data.activity.timeline.length;
  return result.data.video.timeline.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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

  const activityResults: ParseResult[] = [];
  const videoResults:    ParseResult[] = [];
  const skipped:         string[]      = [];
  const failed:          { name: string; error: string }[] = [];

  for (const entry of files) {
    const filePath = path.join(sessionDir, entry.name);
    const adapter  = await NodeFileAdapter.fromPath(filePath);

    const parser = await registry.resolve(adapter);
    if (!parser) {
      console.warn(`  [SKIP] ${entry.name} — no parser matched`);
      skipped.push(entry.name);
      continue;
    }

    console.log(`  [PARSE] ${entry.name} → ${parser.displayName}`);

    try {
      const result = await parser.parse(adapter);
      logVerbose(result);

      if (result.kind === 'activity') activityResults.push(result);
      else                            videoResults.push(result);
    } catch (err: unknown) {
      const msg = (err instanceof Error) ? err.message : String(err);
      console.error(`  [ERROR] ${entry.name}: ${msg}`);
      failed.push({ name: entry.name, error: msg });
    }
  }

  // ── Write output JSON ─────────────────────────────────────────────────────
  const outDir = path.join(sessionDir, 'json');
  await fs.mkdir(outDir, { recursive: true });

  let wrote = 0;

  if (activityResults.length > 0) {
    const outPath = path.join(outDir, 'activity.json');
    const payload = activityResults.length === 1
      ? (activityResults[0].kind === 'activity' ? activityResults[0].data : activityResults[0])
      : activityResults.map(r => r.kind === 'activity' ? r.data : r);

    await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    const pts = activityResults.reduce((s, r) => s + pointCount(r), 0);
    console.log(`\n  [OUT] activity.json — ${pts} timeline points`);
    wrote++;
  }

  if (videoResults.length > 0) {
    const outPath = path.join(outDir, 'video.json');
    const payload = videoResults.length === 1
      ? (videoResults[0].kind === 'video' ? videoResults[0].data : videoResults[0])
      : videoResults.map(r => r.kind === 'video' ? r.data : r);
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    const pts = videoResults.reduce((s, r) => s + pointCount(r), 0);
    console.log(`  [OUT] video.json    — ${pts} points`);
    wrote++;
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`Parsed:  ${activityResults.length + videoResults.length} file(s)`);
  if (skipped.length) console.log(`Skipped: ${skipped.length} — ${skipped.join(', ')}`);
  if (failed.length)  console.log(`Failed:  ${failed.length} — ${failed.map(f => f.name).join(', ')}`);
  if (wrote)          console.log(`Output:  ${outDir}/`);
  console.log('─────────────────────────────────────────\n');

  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});

'use client';

/**
 * Lens Parser — Browser Test Page
 *
 * Drop activity files (GPX, FIT, TCX) or video files (MP4, MOV) here.
 * The parser runs fully client-side and logs the JSON output to the console.
 *
 * This page is the browser equivalent of: npm run parse -- --input ./Input/session1
 * Both paths use the exact same parser code.
 */

import { useCallback, useState } from 'react';

// Dynamic import keeps the parser bundle out of the initial page load
// and avoids SSR issues with binary libraries (gpmf-extract, fit-file-parser)
async function getRegistry() {
  const { registry } = await import('@/lib/parser/index');
  return registry;
}

interface ParseLog {
  id:     number;
  name:   string;
  status: 'parsing' | 'done' | 'skipped' | 'error';
  kind?:  'activity' | 'video';
  points?: number;
  device?: string;
  error?: string;
}

let logId = 0;

export default function ParserPage() {
  const [logs, setLogs] = useState<ParseLog[]>([]);
  const [dragging, setDragging] = useState(false);

  const updateLog = (id: number, patch: Partial<ParseLog>) =>
    setLogs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));

  const parseFiles = useCallback(async (files: FileList | File[]) => {
    const registry = await getRegistry();
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      const id = ++logId;
      setLogs(prev => [...prev, { id, name: file.name, status: 'parsing' }]);

      const parser = await registry.resolve(file);
      if (!parser) {
        updateLog(id, { status: 'skipped' });
        console.warn(`[Lens] No parser for: ${file.name}`);
        continue;
      }

      try {
        console.log(`[Lens] Parsing ${file.name} with ${parser.displayName}...`);
        const result = await parser.parse(file);
        const pts    = result.kind === 'activity'
          ? result.data.activity.timeline.length
          : result.data.video.timeline.length;
        const device = result.kind === 'activity'
          ? result.data.activity.metadata.device
          : result.data.video.metadata.device;
        updateLog(id, { status: 'done', kind: result.kind, points: pts, device });
        console.log(`[Lens] ${file.name} →`, result);
      } catch (err: unknown) {
        const msg = (err instanceof Error) ? err.message : String(err);
        updateLog(id, { status: 'error', error: msg });
        console.error(`[Lens] ${file.name} error:`, err);
      }
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) parseFiles(e.dataTransfer.files);
  }, [parseFiles]);

  const onInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) parseFiles(e.target.files);
  }, [parseFiles]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-start p-8 gap-8">
      {/* Header */}
      <div className="text-center mt-8">
        <h1 className="text-4xl font-black tracking-tight text-white">LENS</h1>
        <p className="text-zinc-400 text-sm mt-1">Parser test — results in console</p>
      </div>

      {/* Drop zone */}
      <label
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        className={[
          'w-full max-w-2xl border-2 border-dashed rounded-2xl p-16',
          'flex flex-col items-center justify-center gap-3 cursor-pointer',
          'transition-colors duration-150',
          dragging
            ? 'border-orange-500 bg-orange-500/10'
            : 'border-zinc-700 hover:border-zinc-500 bg-zinc-900',
        ].join(' ')}
      >
        <input
          type="file"
          multiple
          accept=".gpx,.fit,.tcx,.mp4,.mov,.360"
          className="hidden"
          onChange={onInput}
        />
        <div className="text-5xl">+</div>
        <p className="text-zinc-300 font-medium">Drop files or click to select</p>
        <p className="text-zinc-500 text-sm">GPX · FIT · TCX · GoPro MP4 · iPhone MOV · Insta360 · DJI</p>
      </label>

      {/* Log */}
      {logs.length > 0 && (
        <div className="w-full max-w-2xl flex flex-col gap-2">
          {logs.map(log => (
            <div
              key={log.id}
              className={[
                'rounded-xl px-4 py-3 flex items-center justify-between text-sm',
                log.status === 'done'    && 'bg-zinc-800',
                log.status === 'parsing' && 'bg-zinc-800 animate-pulse',
                log.status === 'skipped' && 'bg-zinc-900 text-zinc-500',
                log.status === 'error'   && 'bg-red-950 text-red-300',
              ].filter(Boolean).join(' ')}
            >
              <span className="font-mono truncate max-w-xs">{log.name}</span>
              {log.status === 'parsing' && <span className="text-zinc-400">parsing…</span>}
              {log.status === 'done' && (
                <span className="text-green-400">
                  {log.kind} · {log.points} pts · {log.device}
                </span>
              )}
              {log.status === 'skipped' && <span>no parser</span>}
              {log.status === 'error' && (
                <span className="text-xs truncate max-w-xs">{log.error}</span>
              )}
            </div>
          ))}

          <button
            onClick={() => setLogs([])}
            className="text-xs text-zinc-600 hover:text-zinc-400 mt-2 text-right"
          >
            clear
          </button>
        </div>
      )}
    </main>
  );
}

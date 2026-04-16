/**
 * NodeFileAdapter — wraps a filesystem path as a FileInput.
 *
 * This is the platform bridge that lets every parser run identically in Node.js
 * (CLI test harness) and in the browser (where native File satisfies FileInput).
 *
 * Key design: slice() uses fs.open + fh.read() for ranged I/O.
 * For a 4 GB GoPro file, findMoovContent() reads only the last ~200 KB —
 * the slice() implementation avoids loading the entire file into memory.
 *
 * Only imported in CLI / Node.js paths. Never bundled into the browser build.
 */

import fs             from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable }   from 'node:stream';
import path           from 'node:path';
import type { FileInput, FileSlice } from './types';

export class NodeFileAdapter implements FileInput {
  readonly name: string;
  readonly size: number;

  private constructor(
    private readonly filePath: string,
    size: number,
  ) {
    this.name = path.basename(filePath);
    this.size = size;
  }

  /** Factory — stat the file to get size, then construct the adapter. */
  static async fromPath(filePath: string): Promise<NodeFileAdapter> {
    const stat = await fs.stat(filePath);
    return new NodeFileAdapter(filePath, stat.size);
  }

  /**
   * Read a specific byte range without touching the rest of the file.
   * Mirrors File.prototype.slice() semantics.
   */
  slice(start: number, end: number): FileSlice {
    const filePath = this.filePath;
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        const length = end - start;
        if (length <= 0) return new ArrayBuffer(0);

        const buf = Buffer.alloc(length);
        const fh  = await fs.open(filePath, 'r');
        try {
          await fh.read(buf, 0, length, start);
        } finally {
          await fh.close();
        }
        // Return a clean ArrayBuffer (Buffer.buffer may be shared/pooled)
        const ab = new ArrayBuffer(length);
        new Uint8Array(ab).set(buf);
        return ab;
      },
    };
  }

  /** Read the entire file as ArrayBuffer. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const buf = await fs.readFile(this.filePath);
    const ab  = new ArrayBuffer(buf.length);
    new Uint8Array(ab).set(buf);
    return ab;
  }

  /** Read the entire file as UTF-8 text. */
  async text(): Promise<string> {
    return fs.readFile(this.filePath, 'utf-8');
  }

  /**
   * Return a Web ReadableStream over the file.
   *
   * gpmf-extract checks `file.stream` first — if present, it skips the
   * `new Blob([file]).stream()` fallback that breaks in Node 22 (Blob is
   * globally defined but NodeFileAdapter is not a valid Blob source).
   *
   * Readable.toWeb() is available in Node 18+.
   */
  stream(): ReadableStream<Uint8Array> {
    const nodeReadable = createReadStream(this.filePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Readable as any).toWeb(nodeReadable) as ReadableStream<Uint8Array>;
  }
}

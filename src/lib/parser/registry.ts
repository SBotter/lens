/**
 * ParserRegistry — singleton that holds all registered device parsers.
 *
 * Usage:
 *   registry.register(MyParser);          // called by each parser module
 *   const parser = await registry.resolve(file);  // returns first match
 *   const result = await parser?.parse(file);
 */

import type { FileInput, Parser } from './types';

class ParserRegistry {
  private readonly parsers: Parser[] = [];

  /**
   * Register a parser. Called once per parser module at import time.
   * Order matters: parsers registered first get priority in resolve().
   */
  register(parser: Parser): void {
    this.parsers.push(parser);
  }

  /**
   * Returns the first parser whose canParse() returns true, or null.
   * Iterates in registration order.
   */
  async resolve(file: FileInput): Promise<Parser | null> {
    for (const p of this.parsers) {
      try {
        if (await p.canParse(file)) return p;
      } catch {
        // canParse must never throw — skip this parser if it does
      }
    }
    return null;
  }

  /** All registered parsers (for diagnostics). */
  list(): readonly Parser[] {
    return this.parsers;
  }
}

export const registry = new ParserRegistry();

// Salted keyed hashing of identifiers. Spec: docs/methodology.md R14.4.
// Output forms: req_<8 hex>, chain_<N>, sess_<N>. The salt is 16 random bytes per run and
// is never stored, serialized, logged or exposed by this module.
import { createHash, randomBytes } from "node:crypto";
import { SafeError } from "./sanitize.ts";

export const SALT_BYTES = 16;

export interface RedactorOptions {
  /**
   * Reproducible salt for tests and demos (the --stable-salt flag). Any non-empty string; it
   * is hashed down to 16 bytes. Never use it for output that leaves the machine.
   */
  stableSalt?: string;
}

export class IdRedactor {
  readonly #salt: Buffer;
  readonly #chains = new Map<string, number>();
  readonly #sessions = new Map<string, number>();
  readonly stable: boolean;

  constructor(opts: RedactorOptions = {}) {
    if (opts.stableSalt !== undefined) {
      if (typeof opts.stableSalt !== "string" || opts.stableSalt.length === 0) {
        throw new SafeError("E_BAD_SALT");
      }
      this.#salt = createHash("sha256").update(opts.stableSalt, "utf8").digest().subarray(0, SALT_BYTES);
      this.stable = true;
    } else {
      this.#salt = randomBytes(SALT_BYTES);
      this.stable = false;
    }
  }

  /** First 8 hex characters of sha256(salt || id). */
  hex8(id: string): string {
    if (typeof id !== "string" || id.length === 0) throw new SafeError("E_BAD_ID");
    return createHash("sha256").update(this.#salt).update(id, "utf8").digest("hex").slice(0, 8);
  }

  /** Request key to req_<8 hex>. */
  request(id: string): string {
    return `req_${this.hex8(id)}`;
  }

  /** Chain/thread/agent id to chain_<N>, N by first appearance. Callers feed ids in a deterministic order. */
  chain(id: string): string {
    return `chain_${ordinal(this.#chains, id)}`;
  }

  /** Session id to sess_<N>, N by first appearance. */
  session(id: string): string {
    return `sess_${ordinal(this.#sessions, id)}`;
  }

  toJSON(): string {
    return "[IdRedactor]";
  }

  toString(): string {
    return "[IdRedactor]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[IdRedactor]";
  }
}

function ordinal(map: Map<string, number>, id: string): number {
  if (typeof id !== "string" || id.length === 0) throw new SafeError("E_BAD_ID");
  let n = map.get(id);
  if (n === undefined) {
    n = map.size + 1;
    map.set(id, n);
  }
  return n;
}

/**
 * Build a redactor from CLI flags: `--stable-salt <value>` or `--stable-salt=<value>`.
 * Without the flag the salt is random per run.
 */
export function redactorFromArgs(argv: readonly string[]): IdRedactor {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--stable-salt") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new SafeError("E_BAD_SALT");
      return new IdRedactor({ stableSalt: v });
    }
    if (a.startsWith("--stable-salt=")) return new IdRedactor({ stableSalt: a.slice("--stable-salt=".length) });
  }
  return new IdRedactor();
}

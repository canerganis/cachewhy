// Terminal sanitizing, safe error formatting and the typed allowlist serializer.
// Spec: docs/methodology.md R14.3 and R14.6. No dependencies beyond node builtins.
// Rule: nothing here ever reads err.message, raw lines or raw input values into output.

// ---------------------------------------------------------------------------
// Terminal control stripping
// ---------------------------------------------------------------------------

// String-type escape sequences (OSC, DCS, SOS, PM, APC): ESC + introducer ... terminator (BEL or ST).
const ESC_STRING = /\u001b[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// CSI sequences.
const ESC_CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
// Two-character escapes and any lone ESC.
const ESC_OTHER = /\u001b[@-Z\\-_]?/g;
// C0, DEL, C1, bidi controls, zero-width and line/paragraph separators, BOM.
const CONTROL_CHARS =
  /[\u{0000}-\u{001F}\u{007F}-\u{009F}\u{061C}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu;

/**
 * Remove C0/C1 control characters, ESC sequences and bidirectional controls.
 * Tabs and newlines are removed too. Use on any string that is not an enum or tool-generated id.
 */
export function stripControl(input: string): string {
  return String(input)
    .replace(ESC_STRING, "")
    .replace(ESC_CSI, "")
    .replace(ESC_OTHER, "")
    .replace(CONTROL_CHARS, "");
}

/** Strip control characters and cap the length (in UTF-16 units). */
export function sanitizeForTerminal(input: string, maxLength = 256): string {
  const s = stripControl(input);
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

// ---------------------------------------------------------------------------
// Safe errors
// ---------------------------------------------------------------------------

const CODE_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const FILE_LABEL_RE = /^file_[0-9]{1,9}$/;
const PATH_RE = /^[A-Za-z0-9_.$[\]]{1,200}$/;

export interface SafeDetails {
  /** 1-based line number. */
  line?: number;
  /** Opaque label such as file_3. Raw paths are rejected. */
  file?: string;
  /** Plain counter. */
  count?: number;
  /** Schema path built from declared keys, such as $.events[2].kind. */
  path?: string;
}

/** Opaque file label for the n-th input file. */
export function fileLabel(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) return "file_0";
  return `file_${n}`;
}

/**
 * Build a message only from an enum-like code, integers and an opaque file label.
 * Anything that does not match the strict shapes is replaced by a fixed placeholder.
 */
export function formatSafeMessage(code: string, details: SafeDetails = {}): string {
  const parts: string[] = [CODE_RE.test(code) ? code : "E_BAD_CODE"];
  if (details.file !== undefined) {
    parts.push(`in ${FILE_LABEL_RE.test(details.file) ? details.file : "file_?"}`);
  }
  if (details.line !== undefined) {
    parts.push(`line ${Number.isSafeInteger(details.line) && details.line >= 0 ? details.line : 0}`);
  }
  if (details.count !== undefined) {
    parts.push(`count ${Number.isSafeInteger(details.count) && details.count >= 0 ? details.count : 0}`);
  }
  if (details.path !== undefined) {
    parts.push(`at ${PATH_RE.test(details.path) ? details.path : "$?"}`);
  }
  return parts.join(" ");
}

/** The only error type whose text may reach the terminal or a file. */
export class SafeError extends Error {
  readonly code: string;
  readonly details: Readonly<SafeDetails>;
  constructor(code: string, details: SafeDetails = {}) {
    super(formatSafeMessage(code, details));
    this.name = "SafeError";
    this.code = CODE_RE.test(code) ? code : "E_BAD_CODE";
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Format any thrown value for output. Never reads `.message`, `.stack` or any property of
 * a non-SafeError. Unknown exceptions become E_INTERNAL.
 */
export function formatError(err: unknown): string {
  if (err instanceof SafeError) return formatSafeMessage(err.code, err.details);
  return "E_INTERNAL";
}

export type ParsedLine = { ok: true; value: unknown } | { ok: false; error: SafeError };

/**
 * Parse one JSONL line. The JSON.parse exception (which can quote input) is discarded and
 * replaced by a SafeError carrying only a code, the line number and the file label.
 */
export function parseJsonLineSafe(line: string, lineNo: number, file?: string): ParsedLine {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    const details: SafeDetails = { line: lineNo };
    if (file !== undefined) details.file = file;
    return { ok: false, error: new SafeError("E_JSON_PARSE", details) };
  }
}

// ---------------------------------------------------------------------------
// Typed allowlist serializer
// ---------------------------------------------------------------------------

export type Schema =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "const"; readonly value: string | number | boolean }
  | {
      readonly kind: "pattern";
      readonly pattern: RegExp;
      readonly maxLength?: number;
      /** If set, a value that fails the pattern is replaced by this string instead of throwing. */
      readonly otherwise?: string;
    }
  | { readonly kind: "int"; readonly min?: number }
  | { readonly kind: "number"; readonly decimals?: number }
  | { readonly kind: "decimal" }
  | { readonly kind: "boolean" }
  | { readonly kind: "iso" }
  | { readonly kind: "nullable"; readonly of: Schema }
  | { readonly kind: "array"; readonly of: Schema; readonly maxItems?: number }
  | {
      readonly kind: "object";
      readonly fields: { readonly [key: string]: Schema };
      readonly optional?: readonly string[];
    };

/** Output type of a schema. */
export type Infer<S extends Schema> = S extends { kind: "enum"; values: readonly (infer V)[] }
  ? V
  : S extends { kind: "const"; value: infer V }
    ? V
    : S extends { kind: "pattern" }
      ? string
      : S extends { kind: "int" | "number" }
        ? number
        : S extends { kind: "decimal" | "iso" }
          ? string
          : S extends { kind: "boolean" }
            ? boolean
            : S extends { kind: "nullable"; of: infer T extends Schema }
              ? Infer<T> | null
              : S extends { kind: "array"; of: infer T extends Schema }
                ? Infer<T>[]
                : S extends { kind: "object"; fields: infer F extends { [k: string]: Schema } }
                  ? { [K in keyof F]: Infer<F[K]> }
                  : never;

/** Schema builders. */
export const s = {
  enum: <const V extends readonly string[]>(values: V) => ({ kind: "enum", values }) as const,
  const: <const V extends string | number | boolean>(value: V) => ({ kind: "const", value }) as const,
  pattern: (pattern: RegExp, opts: { maxLength?: number; otherwise?: string } = {}) =>
    ({ kind: "pattern", pattern, ...opts }) as const,
  int: (min?: number) => ({ kind: "int", ...(min === undefined ? {} : { min }) }) as const,
  number: (decimals?: number) =>
    ({ kind: "number", ...(decimals === undefined ? {} : { decimals }) }) as const,
  decimal: () => ({ kind: "decimal" }) as const,
  boolean: () => ({ kind: "boolean" }) as const,
  iso: () => ({ kind: "iso" }) as const,
  nullable: <const T extends Schema>(of: T) => ({ kind: "nullable", of }) as const,
  array: <const T extends Schema>(of: T, maxItems?: number) =>
    ({ kind: "array", of, ...(maxItems === undefined ? {} : { maxItems }) }) as const,
  object: <const F extends { readonly [key: string]: Schema }>(
    fields: F,
    optional?: readonly string[],
  ) => ({ kind: "object", fields, ...(optional ? { optional } : {}) }) as const,
};

export const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const DECIMAL_RE = /^-?[0-9]{1,40}$/;
const DEFAULT_MAX_STRING = 64;

function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Model id schema: must be in `known` (and match MODEL_ID_RE), otherwise replaced by `unlisted`. */
export function modelIdSchema(known: ReadonlySet<string>): Schema {
  const alts = [...known].filter((m) => MODEL_ID_RE.test(m)).map(escapeRe);
  const source = alts.length > 0 ? `^(?:${alts.join("|")})$` : "(?!)";
  return { kind: "pattern", pattern: new RegExp(source), otherwise: "unlisted" };
}

/** Version schema: semver-like, otherwise replaced by `unlisted`. */
export const versionSchema: Schema = { kind: "pattern", pattern: VERSION_RE, otherwise: "unlisted" };

function violation(path: string): never {
  throw new SafeError("E_SCHEMA_VIOLATION", { path });
}

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Serialize `value` against `schema`. Output is built only from declared keys; undeclared
 * keys are dropped, never copied. A declared field whose value does not satisfy its schema
 * throws a SafeError that names the schema path only (never the value).
 */
export function serialize<S extends Schema>(schema: S, value: unknown): Infer<S> {
  return walk(schema, value, "$") as Infer<S>;
}

/** Convenience: serialize then JSON.stringify. */
export function serializeToJson<S extends Schema>(schema: S, value: unknown, space?: number): string {
  return JSON.stringify(serialize(schema, value), null, space);
}

function walk(schema: Schema, value: unknown, path: string): unknown {
  switch (schema.kind) {
    case "enum": {
      if (typeof value === "string" && schema.values.includes(value)) return value;
      return violation(path);
    }
    case "const": {
      if (value === schema.value) return schema.value;
      return violation(path);
    }
    case "pattern": {
      const max = schema.maxLength ?? DEFAULT_MAX_STRING;
      const re = new RegExp(schema.pattern.source, schema.pattern.flags.replace(/[gy]/g, ""));
      if (typeof value === "string" && value.length <= max && re.test(value)) return value;
      if (schema.otherwise !== undefined) return schema.otherwise;
      return violation(path);
    }
    case "int": {
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= (schema.min ?? Number.MIN_SAFE_INTEGER)
      ) {
        return value;
      }
      return violation(path);
    }
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) {
        return schema.decimals === undefined ? value : Number(value.toFixed(schema.decimals));
      }
      return violation(path);
    }
    case "decimal": {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "string" && DECIMAL_RE.test(value)) return value;
      return violation(path);
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      return violation(path);
    }
    case "iso": {
      if (typeof value === "string" && ISO_RE.test(value) && !Number.isNaN(Date.parse(value))) return value;
      return violation(path);
    }
    case "nullable": {
      return value === null ? null : walk(schema.of, value, path);
    }
    case "array": {
      if (!Array.isArray(value)) return violation(path);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return violation(path);
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) out.push(walk(schema.of, value[i], `${path}[${i}]`));
      return out;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return violation(path);
      const rec = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(schema.fields)) {
        const sub = schema.fields[key] as Schema;
        const childPath = `${path}.${key}`;
        if (!has(rec, key) || rec[key] === undefined) {
          if (schema.optional?.includes(key)) continue;
          return violation(childPath);
        }
        out[key] = walk(sub, rec[key], childPath);
      }
      return out;
    }
  }
}

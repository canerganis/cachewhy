// Formatting helpers: numbers, tokens, tables, color. No dependencies.

/** Decide whether to emit ANSI color. NO_COLOR (any non-empty value) wins. */
export function colorEnabled(
  opts: { noColor?: boolean; env?: Record<string, string | undefined>; isTTY?: boolean } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (opts.noColor) return false;
  const nc = env["NO_COLOR"];
  if (nc !== undefined && nc !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  const tty = opts.isTTY ?? Boolean(process.stdout.isTTY);
  return tty && env["TERM"] !== "dumb";
}

export type ColorName = "red" | "green" | "yellow" | "blue" | "cyan" | "gray" | "bold" | "dim";

const CODES: Record<ColorName, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39],
  gray: [90, 39],
};

export interface Painter {
  (name: ColorName, text: string): string;
  enabled: boolean;
}

export function makePainter(enabled: boolean): Painter {
  const fn = ((name: ColorName, text: string): string => {
    if (!enabled) return text;
    const [open, close] = CODES[name];
    return `\u001b[${open}m${text}\u001b[${close}m`;
  }) as Painter;
  fn.enabled = enabled;
  return fn;
}

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/** Strip ANSI escape sequences (used for width calculation). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** 1234567 -> "1,234,567". Non-finite values render as "n/a". */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return Math.round(n).toLocaleString("en-US");
}

function trim(x: number): string {
  const s = Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1);
  return s.replace(/\.0$/, "");
}

/** Compact token count: 950 -> "950", 12_300 -> "12.3k", 4_500_000 -> "4.5M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return trim(n / 1000) + "k";
  if (abs < 1_000_000_000) return trim(n / 1_000_000) + "M";
  return trim(n / 1_000_000_000) + "B";
}

/** Ratio 0..1 to percent string, e.g. 0.8734 -> "87.3%". */
export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return "n/a";
  return (ratio * 100).toFixed(digits) + "%";
}

/** USD amount, e.g. 1.5 -> "$1.50". Sub-cent values keep 4 decimals. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const digits = Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return "$" + n.toFixed(digits);
}

export type Align = "left" | "right";

export interface Column {
  header: string;
  align?: Align;
}

/**
 * Render a plain text table. Cells may contain ANSI codes; width ignores them.
 * Rows shorter than the header are padded with empty cells.
 */
export function formatTable(columns: Column[], rows: string[][], opts: { indent?: string } = {}): string {
  const indent = opts.indent ?? "";
  const widths = columns.map((c, i) => {
    let w = stripAnsi(c.header).length;
    for (const r of rows) w = Math.max(w, stripAnsi(r[i] ?? "").length);
    return w;
  });
  const pad = (s: string, w: number, a: Align): string => {
    const gap = Math.max(0, w - stripAnsi(s).length);
    return a === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
  };
  const line = (cells: string[]): string =>
    indent + columns.map((c, i) => pad(cells[i] ?? "", widths[i]!, c.align ?? "left")).join("  ").trimEnd();
  const out = [line(columns.map((c) => c.header)), indent + widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// BigInt formatting (R2.16: token and money quantities are never converted to Number)
// ---------------------------------------------------------------------------

/** 1234567n -> "1,234,567". */
export function formatBig(n: bigint): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString();
  const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? "-" + out : out;
}

/** num/den as a percent with one decimal, rounded half up (R2.2). "n/a" when den is 0. Display only. */
export function formatPercentBig(num: bigint, den: bigint): string {
  if (den <= 0n) return "n/a";
  const tenths = (num * 2000n + den) / (2n * den); // round half up of num * 1000 / den
  return `${tenths / 10n}.${tenths % 10n}%`;
}

/**
 * Picodollars to "$1,234.5678" (four decimals, rounded half up at 1e-4 USD). Display only (R3.8): the exact value is
 * in the JSON report. A nonzero amount that rounds to zero prints as "<$0.0001", never as "$0.0000", so a priced
 * response is not read as free. Zero prints "$0.0000".
 */
export function formatUsdPico(pico: bigint, decimals = 4): string {
  const scale = 10n ** BigInt(12 - decimals);
  const units = (pico * 2n + scale) / (2n * scale);
  const unitsPerUsd = 10n ** BigInt(decimals);
  if (pico > 0n && units === 0n) return `<$0.${"0".repeat(decimals - 1)}1`;
  const whole = units / unitsPerUsd;
  const frac = (units % unitsPerUsd).toString().padStart(decimals, "0");
  return `$${formatBig(whole)}.${frac}`;
}

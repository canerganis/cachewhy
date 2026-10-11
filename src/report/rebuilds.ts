// Text and JSON output of `cachewhy rebuilds`. No message content, no paths: sessions are shortened ids.
import type { RebuildReport } from "../rebuilds.js";
import { formatInt, formatTable, formatTokens, formatUsd, type Painter } from "./format.js";

const CAUSE_LABEL: Record<string, string> = {
  model_switch: "model switch",
  compaction_or_clear: "compaction or /clear",
  tools_or_system_changed: "tools or system prompt changed",
  conversation_edited: "earlier messages edited",
  ttl_expired: "idle past cache TTL",
  settings_changed: "request settings changed",
  unknown: "unknown",
};

function when(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function usd(n: number | null): string {
  return n === null ? "-" : formatUsd(n);
}

export function renderRebuilds(r: RebuildReport, top: number, paint: Painter, windowLabel: string): string {
  const lines: string[] = [];
  lines.push(paint("bold", "cachewhy rebuilds") + ` (${windowLabel})`);
  if (r.events.length === 0) {
    lines.push(`Checked ${formatInt(r.requests_checked)} requests. No suspected prefix rebuild found.`);
    return lines.join("\n");
  }
  const { confirmed, hypothesis, unknown } = r.by_level;
  lines.push(
    `Checked ${formatInt(r.requests_checked)} requests. ${formatInt(r.events.length)} suspected prefix rebuilds, ` +
      `${formatTokens(Number(r.rebuilt_total))} tokens processed again, ` +
      `~${formatUsd(r.usd_total)} API list-price equivalent` +
      (r.unpriced_events > 0 ? ` (${formatInt(r.unpriced_events)} events unpriced)` : "") +
      ".",
  );
  lines.push(`Evidence: ${formatInt(confirmed)} confirmed, ${formatInt(hypothesis)} hypotheses, ${formatInt(unknown)} unknown.`);
  lines.push("");
  lines.push(paint("bold", "By cause"));
  lines.push(
    formatTable(
      [{ header: "Cause" }, { header: "Events", align: "right" }, { header: "Tokens rebuilt", align: "right" }, { header: "List-price equiv.", align: "right" }],
      r.by_cause.map((c) => [CAUSE_LABEL[c.cause] ?? c.cause, formatInt(c.events), formatTokens(Number(c.rebuilt)), formatUsd(c.usd)]),
    ),
  );
  lines.push("");
  const shown = r.events.slice(0, top);
  lines.push(paint("bold", `Most expensive ${shown.length} of ${formatInt(r.events.length)}`));
  lines.push(
    formatTable(
      [
        { header: "Time (UTC)" },
        { header: "Agent" },
        { header: "Session" },
        { header: "Model" },
        { header: "Rebuilt", align: "right" },
        { header: "Cost", align: "right" },
        { header: "Evidence" },
        { header: "Why" },
      ],
      shown.map((e) => [
        when(e.t_ms),
        `${e.provider}/${e.kind}`,
        e.session,
        e.model ?? "?",
        formatTokens(Number(e.rebuilt)),
        usd(e.usd),
        e.level === "hypothesis" ? `hypothesis (${e.confidence})` : e.level,
        `${CAUSE_LABEL[e.cause] ?? e.cause}: ${e.detail}`,
      ]),
    ),
  );
  lines.push("");
  lines.push(
    paint(
      "dim",
      "A rebuild is a request that read back less than half of the prefix the previous request in the same thread had cached. " +
        "Costs are API list-price estimates of the extra spend, not your bill.",
    ),
  );
  return lines.join("\n");
}

export function rebuildsToJson(r: RebuildReport, top: number): string {
  return JSON.stringify(
    {
      schema: "cachewhy-rebuilds/1",
      requests_checked: r.requests_checked,
      events_total: r.events.length,
      rebuilt_tokens: r.rebuilt_total.toString(),
      usd_list_price_equivalent: Number(r.usd_total.toFixed(4)),
      unpriced_events: r.unpriced_events,
      by_level: r.by_level,
      by_cause: r.by_cause.map((c) => ({ cause: c.cause, events: c.events, rebuilt_tokens: c.rebuilt.toString(), usd: Number(c.usd.toFixed(4)) })),
      events: r.events.slice(0, top).map((e) => ({
        time: new Date(e.t_ms).toISOString(),
        provider: e.provider,
        kind: e.kind,
        session: e.session,
        model: e.model,
        prev_prefix_tokens: e.prev_prefix.toString(),
        cache_read_tokens: e.cache_read.toString(),
        rebuilt_tokens: e.rebuilt.toString(),
        gap_s: e.gap_s,
        cause: e.cause,
        evidence: e.level,
        confidence: e.confidence,
        detail: e.detail,
        usd: e.usd === null ? null : Number(e.usd.toFixed(4)),
      })),
    },
    null,
    2,
  );
}

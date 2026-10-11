// Writes the README images: assets/demo.svg (an animated terminal run) and assets/how-it-works.svg.
// The demo text is a real run of the author's logs with session ids replaced. Run: node scripts/make-assets.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const C = { bg: "#0d1117", bar: "#161b22", fg: "#c9d1d9", dim: "#8b949e", bold: "#f0f6fc", green: "#3fb950", yellow: "#d29922", red: "#f85149", cyan: "#79c0ff", purple: "#d2a8ff" };

// [text, color, bold]
const OUT = [
  ["cachewhy rebuilds (2026-10-04 to 2026-10-11)", C.bold, true],
  ["Checked 45,362 requests. 497 suspected prefix rebuilds, 129M tokens processed again, ~$645.45 API list-price equivalent.", C.fg],
  ["Evidence: 70 confirmed, 390 hypotheses, 37 unknown.", C.fg],
  ["", C.fg],
  ["By cause", C.bold, true],
  ["Cause                           Events  Tokens rebuilt  List-price equiv.", C.dim],
  ["------------------------------  ------  --------------  -----------------", C.dim],
  ["idle past cache TTL                412            118M            $570.93", C.yellow],
  ["earlier messages edited             11            3.9M             $44.71", C.fg],
  ["unknown                             37            5.1M             $22.13", C.fg],
  ["tools or system prompt changed       8            895k              $5.25", C.fg],
  ["compaction or /clear                22            713k              $1.30", C.fg],
  ["model switch                         4            252k              $0.86", C.fg],
  ["", C.fg],
  ["Most expensive 4 of 497", C.bold, true],
  ["Time (UTC)        Agent            Model             Rebuilt    Cost  Evidence           Why", C.dim],
  ["2026-10-05 04:23  claude/subagent  claude-fable-5-1     894k  $10.95  confirmed          idle past cache TTL: previous cache entry not found", C.green],
  ["2026-10-04 23:05  claude/subagent  claude-fable-5-1     848k  $10.39  hypothesis (high)  idle past cache TTL: idle 25m, cache TTL 5m", C.cyan],
  ["2026-10-04 22:00  claude/subagent  claude-fable-5-1     733k   $8.98  hypothesis (high)  idle past cache TTL: idle 11m, cache TTL 5m", C.cyan],
  ["2026-10-07 12:54  claude/subagent  claude-fable-5-1     677k   $8.29  confirmed          earlier messages edited: Claude reported it", C.green],
];

function demo() {
  const lh = 20, pad = 20, top = 44, cw = 7.8;
  const cmd = "npx cachewhy rebuilds --since 7d";
  const width = Math.ceil(Math.max(...OUT.map((l) => l[0].length)) * cw + pad * 2);
  const height = top + (OUT.length + 2) * lh + pad;
  const typeEnd = 0.3 + cmd.length * 0.05;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13">`);
  out.push(`<style>
.l{opacity:0;animation:show 12s infinite}
@keyframes show{0%{opacity:0}1%{opacity:1}92%{opacity:1}96%{opacity:0}100%{opacity:0}}
.c{clip-path:inset(0 100% 0 0);animation:type 12s steps(${cmd.length}) infinite}
@keyframes type{0%{clip-path:inset(0 100% 0 0);opacity:1}${((typeEnd / 12) * 100).toFixed(1)}%{clip-path:inset(0 0 0 0);opacity:1}92%{clip-path:inset(0 0 0 0);opacity:1}96%{opacity:0}100%{clip-path:inset(0 100% 0 0);opacity:0}}
</style>`);
  out.push(`<rect width="100%" height="100%" rx="10" fill="${C.bg}"/>`);
  out.push(`<rect width="100%" height="30" rx="10" fill="${C.bar}"/><rect y="20" width="100%" height="10" fill="${C.bar}"/>`);
  out.push(`<circle cx="18" cy="15" r="6" fill="#ff5f56"/><circle cx="38" cy="15" r="6" fill="#ffbd2e"/><circle cx="58" cy="15" r="6" fill="#27c93f"/>`);
  out.push(`<text x="${width / 2}" y="19" fill="${C.dim}" text-anchor="middle" font-size="12">cachewhy</text>`);
  out.push(`<text x="${pad}" y="${top + 12}" fill="${C.green}">$ <tspan class="c" fill="${C.fg}">${esc(cmd)}</tspan></text>`);
  OUT.forEach(([t, color, bold], i) => {
    if (!t) return;
    const delay = (typeEnd + 0.6 + i * 0.12).toFixed(2);
    const y = top + 12 + (i + 2) * lh;
    out.push(`<text class="l" style="animation-delay:${delay}s" x="${pad}" y="${y}" fill="${color}"${bold ? ' font-weight="bold"' : ""} xml:space="preserve">${esc(t)}</text>`);
  });
  out.push(`</svg>`);
  return out.join("\n");
}

function diagram() {
  const W = 940, H = 300;
  const box = (x, y, w, h, title, sub, color) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.bar}" stroke="${color}" stroke-width="1.5"/>` +
    `<text x="${x + w / 2}" y="${y + 30}" fill="${C.bold}" font-weight="bold" text-anchor="middle" font-size="15">${esc(title)}</text>` +
    sub.map((s, i) => `<text x="${x + w / 2}" y="${y + 54 + i * 18}" fill="${C.dim}" text-anchor="middle" font-size="12">${esc(s)}</text>`).join("");
  const arrow = (x1, x2, y) => `<line x1="${x1}" y1="${y}" x2="${x2 - 8}" y2="${y}" stroke="${C.dim}" stroke-width="1.5" marker-end="url(#a)"/>`;
  const y = 70, h = 130, w = 190, gap = 40;
  const xs = [30, 30 + w + gap, 30 + 2 * (w + gap), 30 + 3 * (w + gap)];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.dim}"/></marker></defs>`,
    `<rect width="100%" height="100%" rx="12" fill="${C.bg}"/>`,
    `<text x="${W / 2}" y="40" fill="${C.bold}" font-size="18" font-weight="bold" text-anchor="middle">How cachewhy finds a rebuild</text>`,
    box(xs[0], y, w, h, "Local logs", ["~/.claude/projects", "~/.codex/sessions", "read offline"], C.cyan),
    arrow(xs[0] + w, xs[1], y + h / 2),
    box(xs[1], y, w, h, "Threads", ["dedupe by request id", "main, subagents,", "workflows, Codex forks"], C.purple),
    arrow(xs[1] + w, xs[2], y + h / 2),
    box(xs[2], y, w, h, "Rebuild check", ["cache read < half of", "the prefix the previous", "request had cached"], C.yellow),
    arrow(xs[2] + w, xs[3], y + h / 2),
    box(xs[3], y, w, h, "Cause + evidence", ["confirmed: logged reason", "hypothesis: TTL, model,", "compaction, settings"], C.green),
    `<text x="${W / 2}" y="${H - 30}" fill="${C.dim}" font-size="13" text-anchor="middle">Cost = rebuilt tokens x (write or input price - cache read price), API list prices</text>`,
    `</svg>`,
  ].join("\n");
}

// The mark: a cache ring with one segment broken out, and the break highlighted.
function mark(size, ring, accent) {
  const r = size * 0.34, cx = size / 2, cy = size / 2, sw = size * 0.11;
  const pt = (deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const arc = (a, b) => {
    const [x1, y1] = pt(a), [x2, y2] = pt(b);
    return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
  };
  // ring from -40 to 250 degrees, a gap, then the broken segment pushed outward
  const [bx, by] = [size * 0.06, -size * 0.06];
  return (
    `<path d="${arc(-20, 262)}" fill="none" stroke="${ring}" stroke-width="${sw}" stroke-linecap="round"/>` +
    `<g transform="translate(${bx},${by})"><path d="${arc(284, 318)}" fill="none" stroke="${accent}" stroke-width="${sw}" stroke-linecap="round"/></g>` +
    `<circle cx="${cx}" cy="${cy}" r="${size * 0.07}" fill="${accent}"/>`
  );
}

function logo() {
  const s = 128;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" rx="28" fill="#0d1117"/>${mark(s, "#79c0ff", "#f5a524")}</svg>`;
}

function banner(theme) {
  const dark = theme === "dark";
  const fg = dark ? "#f0f6fc" : "#1f2328", sub = dark ? "#8b949e" : "#59636e", ring = dark ? "#79c0ff" : "#0969da";
  const W = 800, H = 200, s = 132;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`,
    `<g transform="translate(36,${(H - s) / 2})">${mark(s, ring, "#f5a524")}</g>`,
    `<text x="190" y="102" fill="${fg}" font-size="64" font-weight="700" letter-spacing="-1.5">cachewhy</text>`,
    `<text x="194" y="140" fill="${sub}" font-size="20">Why your coding agent's prompt cache broke, and what it cost.</text>`,
    `</svg>`,
  ].join("\n");
}

// GitHub social preview, 1280x640. Rendered to PNG by scripts/render-social.ps1 (headless Edge or Chrome).
function social() {
  const W = 1280, H = 640;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;background:#0d1117;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#f0f6fc;overflow:hidden}
.wrap{padding:72px 88px;box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:space-between}
.top{display:flex;align-items:center;gap:28px}
h1{font-size:88px;margin:0;letter-spacing:-2px}
p{font-size:34px;color:#c9d1d9;margin:28px 0 0;max-width:1000px;line-height:1.3}
.stats{display:flex;gap:56px;font-size:24px;color:#8b949e}
.stats b{display:block;font-size:44px;color:#f5a524;margin-bottom:4px}
.foot{font-size:24px;color:#8b949e;font-family:ui-monospace,Consolas,monospace}
.foot span{color:#3fb950}
</style></head><body><div class="wrap">
<div><div class="top"><svg width="120" height="120" viewBox="0 0 120 120">${mark(120, "#79c0ff", "#f5a524")}</svg><h1>cachewhy</h1></div>
<p>Find the prompt cache rebuilds in your Claude Code and Codex sessions, with a cause and an evidence level for each.</p></div>
<div class="stats"><div><b>Subagents</b>and workflows included</div><div><b>Offline</b>no network, no content</div><div><b>Claude + Codex</b>one report</div></div>
<div class="foot"><span>$</span> npx cachewhy rebuilds --since 7d</div>
</div></body></html>`;
}

mkdirSync("assets", { recursive: true });
writeFileSync("assets/demo.svg", demo());
writeFileSync("assets/how-it-works.svg", diagram());
writeFileSync("assets/logo.svg", logo());
writeFileSync("assets/banner-dark.svg", banner("dark"));
writeFileSync("assets/banner-light.svg", banner("light"));
writeFileSync("assets/social.html", social());
console.log("wrote assets/{demo,how-it-works,logo,banner-dark,banner-light}.svg and assets/social.html");

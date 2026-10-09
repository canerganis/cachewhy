// Global integrity abstention (spec R0.9): families, live families and chain taint.
//
// computeTaint turns the integrity facts of one provider (what the parser saw: chains, family links, taint triggers,
// per-file facts) into one ChainTaint per chain. It is a pure function of a set of facts. It reads no file, no clock
// (the run start is a parameter) and no response, and its result does not depend on the order of any input list:
// chain ids are sorted before family numbers are assigned, and every list in the result is in a canonical order.
//
// Rules implemented here (R0.9):
// - Family. Chains are nodes. The family relation is the connected components of the groups the parser supplies
//   (links (i), (ii) and (iii)). A chain of an unverified version is a chain for this purpose.
// - Live families. A file F is live iff F.unparsed_lines > 0, F names at least one chain and
//   run_start - F.mtime <= C35. An mtime after the run start counts as live. Every family that contains a chain named
//   by a live file is live. A live file gives no unparsed_line taint. A file that names no chain is never live.
// - Taint. A reason taints every chain of the family of each chain it names, and a reason that names no chain
//   (names = "provider") taints every chain of the provider. A chain is tainted iff at least one reason applies.
// - Coverage. Live families are excluded from chains_total, chains_tainted, families_total and families_tainted.

import { CONSTANTS, TAINT_REASONS, chainIdOf } from "../model/types.js";
import type {
  ChainId,
  ChainKey,
  ChainTaint,
  FileFacts,
  IntegrityFacts,
  ProviderTaint,
  TaintReason,
} from "../model/types.js";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Union-find over dense indices, with path halving. Roots are chosen by smaller index so the result is canonical. */
class Dsu {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let a = x;
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a] as number] as number;
      a = this.parent[a] as number;
    }
    return a;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

/** R0.9 "Live families": is this file live at the given run start? */
export function isLiveFile(f: FileFacts, run_start_ms: number): boolean {
  if (!f.readable) return false;
  if (f.unparsed_lines <= 0) return false;
  if (f.named_chains.length === 0) return false;
  // An mtime after the run start gives a negative difference, which is "at most C35 before the run start".
  return run_start_ms - f.mtime_ms <= CONSTANTS.LIVE_WINDOW_S * 1000;
}

export function emptyIntegrityFacts(provider: IntegrityFacts["provider"]): IntegrityFacts {
  return { provider, chains: [], family_groups: [], triggers: [], files: [] };
}

function zeroReasons(): Record<TaintReason, number> {
  const o = {} as Record<TaintReason, number>;
  for (const r of TAINT_REASONS) o[r] = 0;
  return o;
}

/**
 * Taint of one provider.
 *
 * `files` are the per-file facts to use (the graph passes them with file indices already made unique across
 * providers); `facts.files` is not read, so a caller that merges several parse results passes the merged list.
 */
export function computeTaint(facts: IntegrityFacts, files: readonly FileFacts[], run_start_ms: number): ProviderTaint {
  // ---- nodes: every chain any fact mentions, sorted --------------------------------------------------------
  const idSet = new Set<ChainId>(facts.chains);
  for (const g of facts.family_groups) for (const c of g) idSet.add(c);
  for (const t of facts.triggers) if (t.names !== "provider") for (const c of t.names) idSet.add(c);
  for (const f of files) for (const c of f.named_chains) idSet.add(c);
  const ids = [...idSet].sort(cmp);
  const index = new Map<ChainId, number>();
  ids.forEach((id, i) => index.set(id, i));

  // ---- families ---------------------------------------------------------------------------------------------
  const dsu = new Dsu(ids.length);
  for (const g of facts.family_groups) {
    const first = g[0];
    if (first === undefined) continue;
    const a = index.get(first) as number;
    for (let k = 1; k < g.length; k++) dsu.union(a, index.get(g[k] as ChainId) as number);
  }
  // Family numbers in order of the smallest member (ids are sorted, so the first id met opens the next number).
  const familyOfRoot = new Map<number, number>();
  const familyOf: number[] = new Array<number>(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const root = dsu.find(i);
    let fam = familyOfRoot.get(root);
    if (fam === undefined) {
      fam = familyOfRoot.size;
      familyOfRoot.set(root, fam);
    }
    familyOf[i] = fam;
  }
  const familyCount = familyOfRoot.size;
  const members: number[][] = Array.from({ length: familyCount }, () => []);
  for (let i = 0; i < ids.length; i++) (members[familyOf[i] as number] as number[]).push(i);

  // ---- live families ----------------------------------------------------------------------------------------
  const liveFamily = new Array<boolean>(familyCount).fill(false);
  const liveFile = new Set<FileFacts>();
  for (const f of files) {
    if (!isLiveFile(f, run_start_ms)) continue;
    liveFile.add(f);
    for (const c of f.named_chains) liveFamily[familyOf[index.get(c) as number] as number] = true;
  }

  // ---- reasons ---------------------------------------------------------------------------------------------
  const famReasons: Set<TaintReason>[] = Array.from({ length: familyCount }, () => new Set<TaintReason>());
  const providerWide = new Set<TaintReason>();
  const apply = (reason: TaintReason, names: readonly ChainId[] | "provider"): void => {
    if (names === "provider") {
      providerWide.add(reason);
      return;
    }
    for (const c of names) (famReasons[familyOf[index.get(c) as number] as number] as Set<TaintReason>).add(reason);
  };
  for (const t of facts.triggers) apply(t.reason, t.names);
  for (const f of files) {
    if (!f.readable) {
      // Defensive: parsers also emit this trigger. Same reason, same naming, so the union is idempotent.
      apply("file_unreadable", "provider");
      continue;
    }
    if (f.unparsed_lines > 0 && !liveFile.has(f)) apply("unparsed_line", f.named_chains.length > 0 ? f.named_chains : "provider");
  }

  // ---- per chain ----------------------------------------------------------------------------------------------
  const chains = new Map<ChainId, ChainTaint>();
  const byReason = zeroReasons();
  let chainsTotal = 0;
  let chainsTainted = 0;
  let familiesTotal = 0;
  let familiesTainted = 0;
  let familiesLive = 0;
  const wideOrdered = TAINT_REASONS.filter((r) => providerWide.has(r));
  for (let fam = 0; fam < familyCount; fam++) {
    const live = liveFamily[fam] as boolean;
    const reasons = new Set<TaintReason>(famReasons[fam]);
    for (const r of providerWide) reasons.add(r);
    const ordered = TAINT_REASONS.filter((r) => reasons.has(r));
    const tainted = ordered.length > 0;
    if (live) familiesLive++;
    else {
      familiesTotal++;
      if (tainted) familiesTainted++;
    }
    for (const i of members[fam] as number[]) {
      chains.set(ids[i] as ChainId, { chain: ids[i] as ChainId, family: fam, tainted, reasons: ordered, live });
      if (live) continue;
      chainsTotal++;
      if (tainted) {
        chainsTainted++;
        for (const r of ordered) byReason[r]++;
      }
    }
  }

  return {
    provider: facts.provider,
    chains,
    families_total: familiesTotal,
    families_tainted: familiesTainted,
    families_live: familiesLive,
    chains_total: chainsTotal,
    chains_tainted: chainsTainted,
    chains_tainted_by_reason: byReason,
    provider_wide_reasons: wideOrdered,
  };
}

/** Taint entry of a chain key, or undefined when the facts never mentioned the chain. */
export function taintOf(t: ProviderTaint, key: ChainKey): ChainTaint | undefined {
  return t.chains.get(chainIdOf(key));
}

import { MINUTE_MS } from "./v9-core";

/**
 * Builds the minute-by-minute story of one V9 signal from stored data only
 * (pure; the tool does the database reads). Each row joins what happened in
 * the market that minute with what the engine saw live at that minute.
 */
export interface StoryInput {
  from: number;
  to: number;
  liquidations: Array<{ ts: number; victim: "LONG" | "SHORT"; usd: number }>;
  oi: Array<{ ts: number; oi: number; price: number | null }>;
  timeline: Array<{ ts: number; oiPhase: string; forming: null | { victim: string; parts: number; start: number } }>;
  positioning: Array<{ ts: number; globalLongPct?: number; topPositionsLongPct?: number }>;
  markers: Array<{ ts: number; label: string }>;
}

export interface StoryRow {
  ts: number;
  price: number | null;
  oi: number | null;
  oiChangePct: number | null; // vs the first minute of the story
  longLiqUsd: number;
  shortLiqUsd: number;
  livePhase: string;          // what the engine saw live (from the timeline)
  liveEpisode: string;        // e.g. "LONG x2 since 03:01"
  globalLongPct: number | null;
  topPositionsLongPct: number | null;
  markers: string[];
}

const minuteOf = (ts: number): number => Math.floor(ts / MINUTE_MS) * MINUTE_MS;
const hhmm = (ts: number): string => new Date(ts).toISOString().slice(11, 16);

export function buildStory(input: StoryInput): StoryRow[] {
  const rows = new Map<number, StoryRow>();
  for (let m = minuteOf(input.from); m <= minuteOf(input.to); m += MINUTE_MS) {
    rows.set(m, { ts: m, price: null, oi: null, oiChangePct: null, longLiqUsd: 0, shortLiqUsd: 0, livePhase: "", liveEpisode: "", globalLongPct: null, topPositionsLongPct: null, markers: [] });
  }
  for (const l of input.liquidations) {
    const r = rows.get(minuteOf(l.ts));
    if (!r) continue;
    if (l.victim === "LONG") r.longLiqUsd += l.usd; else r.shortLiqUsd += l.usd;
  }
  for (const o of [...input.oi].sort((a, b) => a.ts - b.ts)) {
    const r = rows.get(minuteOf(o.ts));
    if (!r) continue;
    r.oi = o.oi; // last poll of the minute wins
    if (o.price !== null) r.price = o.price;
  }
  for (const t of input.timeline) {
    const r = rows.get(minuteOf(t.ts));
    if (!r) continue;
    r.livePhase = t.oiPhase.replace("OI_", "");
    r.liveEpisode = t.forming ? `${t.forming.victim} x${t.forming.parts} since ${hhmm(t.forming.start)}` : "-";
  }
  // positioning is per 5-minute period: carry it forward inside the period
  const pos = [...input.positioning].sort((a, b) => a.ts - b.ts);
  let pi = 0, cur: StoryInput["positioning"][number] | null = null;
  for (const r of rows.values()) {
    while (pi < pos.length && pos[pi].ts <= r.ts) cur = pos[pi++];
    if (cur && r.ts - cur.ts < 5 * MINUTE_MS) {
      r.globalLongPct = cur.globalLongPct ?? null;
      r.topPositionsLongPct = cur.topPositionsLongPct ?? null;
    }
  }
  for (const mk of input.markers) rows.get(minuteOf(mk.ts))?.markers.push(mk.label);
  const out = [...rows.values()];
  const baseOi = out.find((r) => r.oi !== null)?.oi ?? null;
  for (const r of out) r.oiChangePct = baseOi && r.oi !== null ? ((r.oi - baseOi) / baseOi) * 100 : null;
  return out;
}

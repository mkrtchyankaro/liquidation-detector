/**
 * MARKET STRUCTURE ZONES (Johnny, Oct 8 2026) -- PURE: no I/O, no clock. Phase 1: 4h candles only. v2 (rules agreed
 * Oct 8 15:18). The only number: K (consecutive closes), and k (the swing's width).
 *
 * SWING (k): a 4h candle whose high is above the k candles before it and not below the k after it (a swing low the
 *   mirror). pivotTime = its candle; knownAt = when the k candles after it have closed. Used only from knownAt.
 * REJECTION RANGE: a swing high = its upper wick (body top -> high); a swing low = its lower wick (low -> body bottom).
 * ZONE (stable id = side + structure number + the first swing's time): a newly known swing joins the zone of its side (same structure)
 *   whose ZONE overlaps its rejection range (several -> the one with the most swings), else it starts a new zone.
 *   Joining makes a new VERSION of the same zone (history kept), never a new wall.
 *   lo-hi = where the MOST rejection ranges overlap · lo2-hi2 = where >= 2 overlap (the v1 rule, kept to compare)
 *   ext   = the extreme (the highest high / lowest low of its swings) -- where a stop would go
 *   CONFIRMED = >= 2 swings and lo < hi; else PROVISIONAL (1 swing, or rejections touching at one price only)
 * ACTIVE (at most one resistance above, one support below): of the zones of the CURRENT structure beyond the close
 *   (resistance ext >= close, support ext <= close): CONFIRMED before PROVISIONAL, then the most swings; on a tie the
 *   zone already active stays, else the nearest.
 * STATES (down shown; up is the mirror), once per closed 4h candle:
 *   RANGE --close below the support's ext--> BREAKOUT_TEST (testedZoneId: that zone, FROZEN, and both active walls
 *     frozen until it is decided)
 *   BREAKOUT_TEST --close above the tested zone's hi (back in the range)--> FAKE_BREAK -> RANGE
 *   BREAKOUT_TEST --K consecutive closes below its ext AND a swing known by now with pivotTime >= the break candle:
 *     a swing high below the zone (ext < lo) or a swing low below its ext--> BREAKOUT_CONFIRMED
 *     the old zones are SUSPENDED (not deleted); resistance = the broken zone as FLIP; support = null (nothing invented)
 *   BREAKOUT_CONFIRMED --close above the tested zone's hi--> FAILED_BREAKOUT -> RANGE, the suspended zones come back
 *   BREAKOUT_CONFIRMED --swings FORMED AFTER the break candle (pivotTime > it), known by now: a swing low and a swing
 *     high (any order), and the close between the latest of each--> NEW_STRUCTURE -> RANGE of a new structure:
 *     the old zones are ARCHIVED (kept, with the time and the reason); the new zones come only from swings formed
 *     after the break (PROVISIONAL with 1 swing, CONFIRMED with 2)
 */
export interface C4 {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}
export const H4 = 4 * 3_600_000;

export interface Pivot {
  pivotTime: number;
  knownAt: number;
  high: boolean;
  lo: number;
  hi: number;
  ext: number;
  zoneId?: string;
}
export type ZStatus = "CONFIRMED" | "PROVISIONAL";
export interface ZoneVersion {
  T: number;
  v: number;
  added: number;
  lo: number;
  hi: number;
  ext: number;
  n: number;
  status: ZStatus;
}
export interface Zone {
  id: string;
  side: "R" | "S";
  structure: number;
  pivots: Pivot[];
  lo: number;
  hi: number;
  lo2: number;
  hi2: number;
  ext: number;
  status: ZStatus;
  v: number;
  history: ZoneVersion[];
  archived?: { T: number; why: string };
}
/** what a step shows for a wall: the zone (a snapshot of its version) and whether it is the broken zone used as flip */
export interface Wall {
  id: string;
  side: "R" | "S";
  v: number;
  lo: number;
  hi: number;
  lo2: number;
  hi2: number;
  ext: number;
  n: number;
  status: ZStatus;
  flip: boolean;
  frozen: boolean;
}
export type State = "RANGE" | "BREAKOUT_TEST" | "BREAKOUT_CONFIRMED";
export type Event =
  | ""
  | "BREAKOUT_TEST"
  | "FAKE_BREAK"
  | "BREAKOUT_CONFIRMED"
  | "FAILED_BREAKOUT"
  | "NEW_STRUCTURE";
export interface Step {
  T: number;
  i: number;
  close: number;
  structure: number;
  state: State;
  dir: "UP" | "DOWN" | "";
  event: Event;
  note: string;
  testedZoneId: string | null;
  R: Wall | null;
  S: Wall | null;
  archived: string[];
}

export function confirmedSwings(c: readonly C4[], k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i + k < c.length; i++) {
    let hiP = true,
      loP = true;
    for (let j = i - k; j < i; j++) {
      if (!(c[i].h > c[j].h)) hiP = false;
      if (!(c[i].l < c[j].l)) loP = false;
    }
    for (let j = i + 1; j <= i + k; j++) {
      if (!(c[i].h >= c[j].h)) hiP = false;
      if (!(c[i].l <= c[j].l)) loP = false;
    }
    const knownAt = c[i + k].t + H4;
    if (hiP)
      out.push({
        pivotTime: c[i].t,
        knownAt,
        high: true,
        lo: Math.max(c[i].o, c[i].c),
        hi: c[i].h,
        ext: c[i].h,
      });
    if (loP)
      out.push({
        pivotTime: c[i].t,
        knownAt,
        high: false,
        lo: c[i].l,
        hi: Math.min(c[i].o, c[i].c),
        ext: c[i].l,
      });
  }
  return out.sort((a, b) => a.knownAt - b.knownAt || a.pivotTime - b.pivotTime);
}

/** the prices covered by the most ranges (lo-hi) and by >= 2 (lo2-hi2) */
export function overlapCore(rs: readonly { lo: number; hi: number }[]): {
  lo: number;
  hi: number;
  lo2: number;
  hi2: number;
} {
  if (rs.length === 1)
    return { lo: rs[0].lo, hi: rs[0].hi, lo2: rs[0].lo, hi2: rs[0].hi };
  const pts = [...new Set(rs.flatMap((p) => [p.lo, p.hi]))].sort(
    (x, y) => x - y,
  );
  const cover = (a: number, b: number): number =>
    rs.filter((p) => p.lo <= a && p.hi >= b).length;
  let best = 0;
  const segs: { a: number; b: number; n: number }[] = [];
  for (let j = 0; j + 1 < pts.length; j++) {
    const n = cover(pts[j], pts[j + 1]);
    segs.push({ a: pts[j], b: pts[j + 1], n });
    best = Math.max(best, n);
  }
  const point = pts
    .map((x) => ({ x, n: cover(x, x) }))
    .sort((p, q) => q.n - p.n)[0];
  let lo = Infinity,
    hi = -Infinity,
    lo2 = Infinity,
    hi2 = -Infinity;
  if (best >= point.n)
    for (const s of segs)
      if (s.n === best) {
        lo = Math.min(lo, s.a);
        hi = Math.max(hi, s.b);
      }
  for (const s of segs)
    if (s.n >= 2) {
      lo2 = Math.min(lo2, s.a);
      hi2 = Math.max(hi2, s.b);
    }
  if (!Number.isFinite(lo)) lo = hi = point.x; // the most overlap is at a single price (touching)
  if (!Number.isFinite(lo2)) {
    lo2 = hi2 = point.n >= 2 ? point.x : lo;
  }
  return { lo, hi, lo2, hi2 };
}

const wallOf = (z: Zone, flip = false, frozen = false): Wall => ({
  id: z.id,
  side: flip ? (z.side === "R" ? "S" : "R") : z.side,
  v: z.v,
  lo: z.lo,
  hi: z.hi,
  lo2: z.lo2,
  hi2: z.hi2,
  ext: z.ext,
  n: z.pivots.length,
  status: z.status,
  flip,
  frozen,
});

export function runStructure(
  c: readonly C4[],
  k: number,
  K: number,
): { steps: Step[]; pivots: Pivot[]; zones: Zone[] } {
  const pivots = confirmedSwings(c, k);
  const zones: Zone[] = [];
  const steps: Step[] = [];
  let structure = 1,
    structFrom = -Infinity; // swings of the current structure: pivotTime >= structFrom
  const fed = new Set<Pivot>();
  let state: State = "RANGE",
    dir: "UP" | "DOWN" | "" = "";
  let test: { Z: Wall; tb: number; run: number; accepted: boolean } | null =
    null;
  let R = null as Wall | null,
    S = null as Wall | null;

  const feed = (p: Pivot, T: number): void => {
    const side = p.high ? "R" : "S";
    const fit = zones
      .filter(
        (z) =>
          z.structure === structure &&
          z.side === side &&
          !z.archived &&
          p.lo <= z.hi &&
          z.lo <= p.hi,
      )
      .sort((a, b) => b.pivots.length - a.pivots.length);
    let z = fit[0];
    if (!z) {
      z = {
        id: `${side}${structure}-${p.pivotTime}`,
        side,
        structure,
        pivots: [],
        lo: p.lo,
        hi: p.hi,
        lo2: p.lo,
        hi2: p.hi,
        ext: p.ext,
        status: "PROVISIONAL",
        v: 0,
        history: [],
      };
      zones.push(z);
    }
    z.pivots.push(p);
    p.zoneId = z.id;
    const core = overlapCore(z.pivots);
    z.lo = core.lo;
    z.hi = core.hi;
    z.lo2 = core.lo2;
    z.hi2 = core.hi2;
    z.ext =
      side === "R"
        ? Math.max(...z.pivots.map((q) => q.ext))
        : Math.min(...z.pivots.map((q) => q.ext));
    z.status =
      z.pivots.length >= 2 && z.hi > z.lo ? "CONFIRMED" : "PROVISIONAL";
    z.v++;
    z.history.push({
      T,
      v: z.v,
      added: p.pivotTime,
      lo: z.lo,
      hi: z.hi,
      ext: z.ext,
      n: z.pivots.length,
      status: z.status,
    });
  };
  const pick = (side: "R" | "S", C: number, prev: Wall | null): Wall | null => {
    const ok = zones.filter(
      (z) =>
        z.structure === structure &&
        !z.archived &&
        z.side === side &&
        (side === "R" ? z.ext >= C : z.ext <= C),
    );
    if (!ok.length) return null;
    const rank = (z: Zone): number =>
      (z.status === "CONFIRMED" ? 1e6 : 0) + z.pivots.length;
    const top = Math.max(...ok.map(rank)),
      best = ok.filter((z) => rank(z) === top);
    const same =
      prev && !prev.flip ? best.find((z) => z.id === prev.id) : undefined;
    if (same) return wallOf(same);
    const dist = (z: Zone): number =>
      side === "R" ? Math.max(0, z.lo - C) : Math.max(0, C - z.hi);
    return wallOf(best.sort((a, b) => dist(a) - dist(b))[0]);
  };

  for (let i = 0; i < c.length; i++) {
    const T = c[i].t + H4,
      C = c[i].c;
    let event: Event = "",
      note = "";
    const archived: string[] = [];
    // swings that became known at this close, in the current structure
    for (const p of pivots)
      if (!fed.has(p) && p.knownAt <= T && p.pivotTime >= structFrom) {
        fed.add(p);
        feed(p, T);
      }

    if (state === "RANGE") {
      if (R && C > R.ext) {
        state = "BREAKOUT_TEST";
        dir = "UP";
        test = {
          Z: { ...R, frozen: true },
          tb: c[i].t,
          run: 1,
          accepted: K <= 1,
        };
        event = "BREAKOUT_TEST";
        note = `close ${C} above ${R.id} ext ${R.ext}`;
      } else if (S && C < S.ext) {
        state = "BREAKOUT_TEST";
        dir = "DOWN";
        test = {
          Z: { ...S, frozen: true },
          tb: c[i].t,
          run: 1,
          accepted: K <= 1,
        };
        event = "BREAKOUT_TEST";
        note = `close ${C} below ${S.id} ext ${S.ext}`;
      }
    } else if (test) {
      const up = dir === "UP",
        Z = test.Z;
      const back = up ? C < Z.lo : C > Z.hi;
      if (back) {
        event = state === "BREAKOUT_TEST" ? "FAKE_BREAK" : "FAILED_BREAKOUT";
        note = `close ${C} back inside the range (${up ? "below" : "above"} ${Z.id} ${up ? "lo " + Z.lo : "hi " + Z.hi})`;
        state = "RANGE";
        dir = "";
        test = null;
      } else {
        if (state === "BREAKOUT_TEST") {
          test.run = (up ? C > Z.ext : C < Z.ext) ? test.run + 1 : 0;
          if (test.run >= K) test.accepted = true;
          const sw = pivots.find(
            (p) =>
              p.knownAt <= T &&
              p.pivotTime >= test!.tb &&
              (up
                ? (!p.high && p.ext > Z.hi) || (p.high && p.ext > Z.ext)
                : (p.high && p.ext < Z.lo) || (!p.high && p.ext < Z.ext)),
          );
          if (test.accepted && sw) {
            state = "BREAKOUT_CONFIRMED";
            event = "BREAKOUT_CONFIRMED";
            note = `${K} closes ${up ? "above" : "below"} ${Z.ext} and swing ${sw.high ? "high" : "low"} ${sw.ext} (candle ${sw.pivotTime}, known ${sw.knownAt})`;
          }
        } else {
          // BREAKOUT_CONFIRMED: has a new structure formed? swings formed after the break, both sides
          const after = pivots.filter(
            (p) => p.knownAt <= T && p.pivotTime > test!.tb,
          );
          const lows = after.filter((p) => !p.high),
            highs = after.filter((p) => p.high);
          if (lows.length && highs.length) {
            const L = lows[lows.length - 1],
              Hh = highs[highs.length - 1];
            if (C >= L.ext && C <= Hh.ext) {
              event = "NEW_STRUCTURE";
              note = `after the break: swing low ${L.ext} and swing high ${Hh.ext}, close ${C} between`;
              for (const z of zones)
                if (z.structure === structure && !z.archived) {
                  z.archived = { T, why: `NEW_STRUCTURE ${dir}` };
                  archived.push(z.id);
                }
              structure++;
              structFrom = test.tb + 1;
              state = "RANGE";
              dir = "";
              test = null;
              for (const p of pivots)
                if (p.knownAt <= T && p.pivotTime >= structFrom) {
                  fed.add(p);
                  feed(p, T);
                }
            }
          }
        }
      }
    }
    // the walls shown after this close
    if (state === "BREAKOUT_TEST" && test) {
      /* frozen: R and S stay as they were */ if (event === "BREAKOUT_TEST") {
        if (dir === "UP") R = test.Z;
        else S = test.Z;
      }
    } else if (state === "BREAKOUT_CONFIRMED" && test) {
      const flip: Wall = {
        ...test.Z,
        side: (dir === "UP" ? "S" : "R") as "R" | "S",
        flip: true,
        frozen: false,
      };
      if (dir === "UP") {
        S = flip;
        R = null;
      } else {
        R = flip;
        S = null;
      }
    } else {
      R = pick("R", C, R);
      S = pick("S", C, S);
    }
    steps.push({
      T,
      i,
      close: C,
      structure,
      state,
      dir,
      event,
      note,
      testedZoneId: test ? test.Z.id : null,
      R,
      S,
      archived,
    });
  }
  return { steps, pivots, zones };
}

export const wallKey = (w: Wall | null): string =>
  w ? `${w.id}|${w.v}|${w.flip}|${w.frozen}` : "null";

/**
 * MARKET STRUCTURE ZONES (Johnny, Oct 8 2026) -- PURE: no I/O, no clock. Phase 1: 4h candles only.
 *
 * SWING (k): a 4h candle whose high is above the k candles before it and not below the k after it (a swing low the
 *   mirror). It is KNOWN only when the k candles after it have closed -- from then on, never before.
 * REJECTION RANGE: a swing high = its upper wick (body top -> high); a swing low = its lower wick (low -> body bottom).
 * ZONE: swings of one side, in time order: a swing whose rejection range overlaps a group's ZONE joins that group
 *   (no number used; overlapping only a neighbour's wick is not enough, so wicks do not chain into one huge zone):
 *   lo-hi   = the prices where at least 2 rejections overlap (one long wick does not widen it);
 *             a group of 1 swing = its own wick, marked weak
 *   ext     = the extreme of the group (the highest high / the lowest low) -- where a stop would go
 *   known   = when its last swing became known
 * ACTIVE: only swings of the CURRENT structure (since the last NEW_STRUCTURE). Resistance = of the groups above the
 *   close (ext >= close) the one with the most swings; on a tie the one already active, else the nearest; Support
 *   the mirror. None -> null.
 * STATES, once per closed 4h candle, against the zones active BEFORE that candle closed:
 *   RANGE          the close is between the zones (or there is no zone to break)
 *   BREAKOUT_TEST  a close beyond the zone's EXTREME
 *   FAKE_BREAK     during the test a close back inside the old range (beyond the zone's inner edge) -> RANGE again
 *   NEW_STRUCTURE  K consecutive closes beyond the extreme AND, after the break, a KNOWN swing on the new side that
 *                  stayed beyond the zone's inner edge (up: a swing low above the old resistance's lo).
 *                  The old zones are archived (kept, inactive); the broken zone becomes a candidate on the other
 *                  side (FLIP: old resistance -> support); new zones come only from swings after the break.
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
  i: number;
  t: number;
  known: number;
  high: boolean;
  lo: number;
  hi: number;
  ext: number;
}
export interface Zone {
  side: "R" | "S";
  lo: number;
  hi: number;
  ext: number;
  n: number;
  known: number;
  weak: boolean;
  flip: boolean;
  pivots: number[];
}
export type State = "RANGE" | "BREAKOUT_TEST_UP" | "BREAKOUT_TEST_DOWN";
export interface Step {
  /** the candle's close time = when this step's result is known */
  T: number;
  i: number;
  close: number;
  state: State;
  event:
    | ""
    | "BREAKOUT_TEST_UP"
    | "BREAKOUT_TEST_DOWN"
    | "FAKE_BREAK"
    | "NEW_STRUCTURE_UP"
    | "NEW_STRUCTURE_DOWN";
  R: Zone | null;
  S: Zone | null;
  /** zones archived at this step (by a NEW_STRUCTURE) */
  archived: Zone[];
  note: string;
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
    const known = c[i + k].t + H4;
    if (hiP)
      out.push({
        i,
        t: c[i].t,
        known,
        high: true,
        lo: Math.max(c[i].o, c[i].c),
        hi: c[i].h,
        ext: c[i].h,
      });
    if (loP)
      out.push({
        i,
        t: c[i].t,
        known,
        high: false,
        lo: c[i].l,
        hi: Math.min(c[i].o, c[i].c),
        ext: c[i].l,
      });
  }
  return out;
}

/** the zone of a group: lo-hi = the prices covered by >= 2 rejection ranges (a group of 1 = its own range) */
function coreOf(g: readonly Pivot[]): { lo: number; hi: number } {
  if (g.length < 2) return { lo: g[0].lo, hi: g[0].hi };
  const pts = [...new Set(g.flatMap((p) => [p.lo, p.hi]))].sort(
    (x, y) => x - y,
  );
  let lo = Infinity,
    hi = -Infinity;
  for (let j = 0; j + 1 < pts.length; j++) {
    const a = pts[j],
      b = pts[j + 1];
    if (g.filter((p) => p.lo <= a && p.hi >= b).length >= 2) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
  }
  if (Number.isFinite(lo)) return { lo, hi };
  const touch =
    pts.find((x) => g.filter((p) => p.lo <= x && p.hi >= x).length >= 2) ??
    g[0].lo; // touching at one price
  return { lo: touch, hi: touch };
}

/** swings in time order; a swing joins the group whose ZONE (not any member) its rejection range overlaps -- so a
 *  long chain of neighbouring wicks does not become one huge zone; several fit -> the one with the most swings */
export function buildZones(ps: readonly Pivot[], side: "R" | "S"): Zone[] {
  const groups: Pivot[][] = [];
  for (const p of [...ps].sort((a, b) => a.t - b.t)) {
    const fit = groups
      .filter((g) => {
        const z = coreOf(g);
        return p.lo <= z.hi && z.lo <= p.hi;
      })
      .sort((a, b) => b.length - a.length);
    if (fit.length) fit[0].push(p);
    else groups.push([p]);
  }
  return groups.map((g) => {
    const { lo, hi } = coreOf(g);
    const ext =
      side === "R"
        ? Math.max(...g.map((p) => p.ext))
        : Math.min(...g.map((p) => p.ext));
    return {
      side,
      lo,
      hi,
      ext,
      n: g.length,
      known: Math.max(...g.map((p) => p.known)),
      weak: g.length < 2,
      flip: false,
      pivots: g.map((p) => p.t).sort((x, y) => x - y),
    };
  });
}

/** the most swings; on a tie the zone already active stays (no flicker), else the nearest */
const pick = (
  zs: Zone[],
  close: number,
  side: "R" | "S",
  prev: Zone | null,
): Zone | null => {
  const ok = zs.filter((z) => (side === "R" ? z.ext >= close : z.ext <= close));
  if (!ok.length) return null;
  const top = Math.max(...ok.map((z) => z.n)),
    best = ok.filter((z) => z.n === top);
  const same = prev
    ? best.find((z) => z.pivots[0] === prev.pivots[0] && z.flip === prev.flip)
    : undefined;
  if (same) return same;
  const dist = (z: Zone): number =>
    side === "R" ? Math.max(0, z.lo - close) : Math.max(0, close - z.hi);
  return best.sort((a, b) => dist(a) - dist(b))[0];
};

export function runStructure(
  c: readonly C4[],
  k: number,
  K: number,
): { steps: Step[]; pivots: Pivot[] } {
  const pivots = confirmedSwings(c, k);
  const steps: Step[] = [];
  let start = -Infinity,
    state: State = "RANGE";
  let test: { Z: Zone; tb: number; run: number; accepted: boolean } | null =
    null;
  let flips: Zone[] = [];
  let R: Zone | null = null,
    S: Zone | null = null;
  for (let i = 0; i < c.length; i++) {
    const T = c[i].t + H4,
      C = c[i].c;
    let event: Step["event"] = "",
      note = "";
    const archived: Zone[] = [];
    const known = pivots.filter((p) => p.known <= T && p.t >= start);
    // 1 the state machine, against the zones active before this close
    if (state === "RANGE") {
      if (R && C > R.ext) {
        state = "BREAKOUT_TEST_UP";
        event = "BREAKOUT_TEST_UP";
        test = { Z: R, tb: c[i].t, run: 1, accepted: K <= 1 };
        note = `close ${C} above the resistance's extreme ${R.ext}`;
      } else if (S && C < S.ext) {
        state = "BREAKOUT_TEST_DOWN";
        event = "BREAKOUT_TEST_DOWN";
        test = { Z: S, tb: c[i].t, run: 1, accepted: K <= 1 };
        note = `close ${C} below the support's extreme ${S.ext}`;
      }
    } else if (test) {
      const up = state === "BREAKOUT_TEST_UP",
        Z = test.Z;
      if (event === "" && (up ? C < Z.lo : C > Z.hi)) {
        event = "FAKE_BREAK";
        note = `close ${C} back inside the old range (${up ? "below" : "above"} ${up ? Z.lo : Z.hi})`;
        state = "RANGE";
        test = null;
      } else {
        if (i > 0 && c[i].t !== test.tb) {
          if (up ? C > Z.ext : C < Z.ext) test.run++;
          else test.run = 0;
        }
        if (test.run >= K) test.accepted = true;
      }
    }
    if (test && event !== "FAKE_BREAK") {
      const up = state === "BREAKOUT_TEST_UP",
        Z = test.Z;
      const sw = known.find(
        (p) =>
          p.t >= test!.tb &&
          (up ? !p.high && p.ext > Z.lo : p.high && p.ext < Z.hi),
      );
      if (test.accepted && sw && (up ? C > Z.lo : C < Z.hi)) {
        event = up ? "NEW_STRUCTURE_UP" : "NEW_STRUCTURE_DOWN";
        note = `${K} closes ${up ? "above" : "below"} ${Z.ext} and a swing ${up ? "low" : "high"} ${sw.ext} (${up ? "above" : "below"} the old zone's ${up ? "lo" : "hi"} ${up ? Z.lo : Z.hi})`;
        for (const z of [R, S, Z, ...flips])
          if (z && !archived.includes(z)) archived.push(z);
        flips = [{ ...Z, side: up ? "S" : "R", flip: true, known: T }];
        start = test.tb;
        state = "RANGE";
        test = null;
      }
    }
    // 2 the zones known at this close
    const now = pivots.filter((p) => p.known <= T && p.t >= start);
    const zr = [
      ...buildZones(
        now.filter((p) => p.high),
        "R",
      ),
      ...flips.filter((z) => z.side === "R"),
    ];
    const zs = [
      ...buildZones(
        now.filter((p) => !p.high),
        "S",
      ),
      ...flips.filter((z) => z.side === "S"),
    ];
    R = pick(zr, C, "R", R);
    S = pick(zs, C, "S", S);
    steps.push({ T, i, close: C, state, event, R, S, archived, note });
  }
  return { steps, pivots };
}

export const zoneKey = (z: Zone | null): string =>
  z ? `${z.side}|${z.lo}|${z.hi}|${z.ext}|${z.n}|${z.flip}` : "null";

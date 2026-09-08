import type {
  ResearchCheckpoint,
  ResearchCheckpointAnchor,
  ResearchCheckpointGroup,
  ResearchCheckpointOffset,
} from "./research-checkpoint.model";

/** Fixed, sparse offsets -- deliberately NOT per-tick. See this
 *  file's own module doc comment. */
const OFFSETS_MS: ReadonlyArray<{
  label: ResearchCheckpointOffset;
  ms: number;
}> = [
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "60m", ms: 60 * 60_000 },
];

/** Safety cleanup: a watch that hasn't completed all 5 offsets within
 *  this long (e.g. the symbol went quiet, or the process restarted
 *  and lost in-memory state) is dropped rather than held forever. */
const MAX_WATCH_AGE_MS = 90 * 60_000;

interface Normalization {
  readonly kind: "R" | "ATR";
  readonly dirMul: 1 | -1;
  /** Risk distance (R) or ATR-absolute (ATR) -- the denominator for
   *  mfe/mae. Never zero/negative (callers must not register a watch
   *  with an unusable denominator; see registerWatch's own guard). */
  readonly denom: number;
}

interface Watch {
  readonly signalId: string;
  readonly symbol: string;
  readonly anchorType: ResearchCheckpointAnchor;
  readonly anchorTs: number;
  readonly anchorPrice: number;
  readonly normalization: Normalization;
  bestPrice: number; // literal max price seen since anchor (direction-agnostic)
  worstPrice: number; // literal min price seen since anchor (direction-agnostic)
  nextOffsetIdx: number;
}

/**
 * Sep 8 2026 (Karo). Domain-pure, in-memory, GLOBAL (never per-user --
 * see research-checkpoint.model.ts's own doc comment). Tracks price
 * forward from an episode's own anchor moment (exhaustion-candidate /
 * signal / episode-end) and emits a checkpoint at each of 5 fixed,
 * sparse offsets. Zero Mongo/network I/O in this class -- the
 * orchestration layer (market-data-orchestrator.ts) is the only thing
 * that persists what onTick() returns.
 */
export class ResearchCheckpointTracker {
  private readonly watches = new Map<string, Watch>(); // keyed by signalId -- one watch per episode, by design (see registerWatch)

  /** Registers a new watch. Silently ignored (never throws) if a
   *  watch for this signalId already exists (one watch per episode by
   *  design -- SIGNAL supersedes EXHAUSTION_CANDIDATE for the same
   *  signalId, never both) or if the normalization denominator is
   *  unusable (<=0 -- would produce Infinity/NaN forever). */
  registerWatch(
    signalId: string,
    symbol: string,
    anchorType: ResearchCheckpointAnchor,
    anchorTs: number,
    anchorPrice: number,
    normalization: Normalization,
  ): void {
    if (this.watches.has(signalId)) return;
    if (!(normalization.denom > 0)) return;
    if (!(anchorPrice > 0)) return;
    this.watches.set(signalId, {
      signalId,
      symbol,
      anchorType,
      anchorTs,
      anchorPrice,
      normalization,
      bestPrice: anchorPrice,
      worstPrice: anchorPrice,
      nextOffsetIdx: 0,
    });
  }

  /** Called once per relevant price tick for `symbol`. Updates every
   *  active watch's own running best/worst price, and returns
   *  whichever watches just crossed their NEXT offset threshold
   *  (there can be more than one if ticks are sparse -- every
   *  threshold still gets emitted, none silently skipped). Completed
   *  (all 5 offsets recorded) or stale (>MAX_WATCH_AGE_MS) watches are
   *  removed from memory here. */
  onTick(
    symbol: string,
    price: number,
    now: number,
  ): ReadonlyArray<{
    signalId: string;
    group: ResearchCheckpointGroup;
    checkpoint: ResearchCheckpoint;
    done: boolean;
  }> {
    if (!(price > 0)) return [];
    const out: Array<{
      signalId: string;
      group: ResearchCheckpointGroup;
      checkpoint: ResearchCheckpoint;
      done: boolean;
    }> = [];

    for (const [signalId, w] of this.watches) {
      if (w.symbol !== symbol) continue;

      const elapsed = now - w.anchorTs;
      if (elapsed > MAX_WATCH_AGE_MS) {
        this.watches.delete(signalId);
        continue;
      }

      if (price > w.bestPrice) w.bestPrice = price;
      if (price < w.worstPrice) w.worstPrice = price;

      while (
        w.nextOffsetIdx < OFFSETS_MS.length &&
        elapsed >= OFFSETS_MS[w.nextOffsetIdx]!.ms
      ) {
        const offset = OFFSETS_MS[w.nextOffsetIdx]!;
        // Sep 8 2026 (Karo) -- bestPrice/worstPrice above are literal
        // (direction-agnostic) max/min. "Favorable" depends on
        // dirMul: for a LONG-convention watch (dirMul=+1) favorable
        // is the highest price seen; for a SHORT-convention watch
        // (dirMul=-1) favorable is the LOWEST price seen -- so which
        // literal extreme counts as "favorable" vs "adverse" flips
        // with dirMul, computed here rather than by direction-aware
        // tracking on every single tick (simpler, same result).
        const favorablePrice =
          w.normalization.dirMul === 1 ? w.bestPrice : w.worstPrice;
        const adversePrice =
          w.normalization.dirMul === 1 ? w.worstPrice : w.bestPrice;
        const mfe =
          ((favorablePrice - w.anchorPrice) * w.normalization.dirMul) /
          w.normalization.denom;
        const mae =
          ((w.anchorPrice - adversePrice) * w.normalization.dirMul) /
          w.normalization.denom;
        const checkpoint: ResearchCheckpoint = {
          offsetLabel: offset.label,
          atMs: elapsed,
          price,
          mfe,
          mae,
          normalization: w.normalization.kind,
        };
        w.nextOffsetIdx += 1;
        const done = w.nextOffsetIdx >= OFFSETS_MS.length;
        out.push({
          signalId,
          group: {
            anchorType: w.anchorType,
            anchorTs: w.anchorTs,
            anchorPrice: w.anchorPrice,
            checkpoints: [checkpoint],
          },
          checkpoint,
          done,
        });
        if (done) {
          this.watches.delete(signalId);
          break;
        }
      }
    }

    return out;
  }

  /** Diagnostic only -- current watch count, e.g. for logging. */
  get activeWatchCount(): number {
    return this.watches.size;
  }
}

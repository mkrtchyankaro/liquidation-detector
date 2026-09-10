import type { Side } from "../../shared/common.types";
import type {
  V5Wave,
  V5Wave1Diagnostics,
  V5TerminalReason,
} from "../../strategy/v5/v5-wave.model";
import type {
  ResearchCheckpointGroup,
  ResearchCheckpoint,
} from "./research-checkpoint.model";

/**
 * Sep 8 2026 (Karo). Split from liqwatch-bot's own single, mixed
 * V5SignalDoc (strategy-v2/v5/v5-wave.model.ts), which combined
 * strategy-decision fields together with per-execution fields
 * (isLive, binanceSlOrderId, positionQty, riskUsd, status:
 * OPEN/CLOSED_TP/CLOSED_SL, etc). Those per-execution fields now live
 * in UserSignalDoc (user-signal.model.ts) instead -- ONE per (userId,
 * signalId) pair. This document is the SAME for every user; it is
 * never mutated by any single user's own Binance/Telegram lifecycle.
 */
export interface GlobalSignalDoc {
  signalId: string;
  symbol: string;
  side: Side;
  victim: Side;
  signalTs: number;
  entryPrice: number;
  entryWaveNumber: number;

  /** Sep 10 2026 (Karo), operator-requested production V5 multi-
   *  timeframe cascade lifecycle -- PURELY ADDITIVE fields. cascadeId
   *  links every 1m/3m/5m candidate signal that originated from the
   *  SAME liquidation cascade -- each candidate still gets its own,
   *  fully independent signalId (this document's own signalId field),
   *  exactly as before. Both null for any legacy/non-cascade signal
   *  (the entire existing V5 signal path). */
  cascadeId: string | null;
  timeframe: "1m" | "3m" | "5m" | null;

  waveHistory: V5Wave[];
  w1Diagnostics: V5Wave1Diagnostics | null;

  totalEpisodePressure: number;
  dominantLayerLiqUsd: number | null;
  dominantLayerWaveNumber: number | null;
  exhaustionLayerLiqUsd: number | null;
  exhaustionLayerWaveNumber: number | null;
  unitAtStart: number;
  p95AtEntry: number;
  dailyLiqPerMinBaselineAtEntry: number;
  atr15mAtEntry: number;

  qualifyingEventUsd: number;
  qualifyingEventTs: number;
  p95AtQualification: number;

  physics: {
    cumLiqUsd: number;
    atrPct: number;
    liqBaseline: number;
    liqStrengthRaw: number;
    liqStrength: number;
    physicsTPPct: number;
    wallAdjustedTpPct: number;
    wallApplied: boolean;
    rrCandidate: number;
    slCapApplied: boolean;
    slCapValue: number;
    finalTpPct: number;
    finalSlPct: number;
    actualRR: number;
    structuralSoftExitPrice: number;
    structuralRiskPct: number;
    sizingRiskPct: number;
    hardStopRiskPct: number;
    liquidityStrengthP95: number;
    liquidityStrength24h: number;
    liquidityStrength: number;
    w2ToW1Ratio: number;
    exhaustionScore: number;
    w1DisplacementAtr: number;
    absorptionRaw: number;
    absorptionScore: number;
    dynamicPhysicsScore: number;
    selectedRR: number;
    tpMultiplier: number;
    slDeterminedBy: "physics" | "sizing-floor";
  } | null;

  btcContext: {
    priceAtSignal: number | null;
    oiAtSignal: number | null;
  } | null;
  liq24hContext: { dayLiqTotalUsd: number; dayLiqEvents: number } | null;
  wallContext: {
    topBidNotional: number;
    topAskNotional: number;
    topBidPrice: number;
    topAskPrice: number;
    imbalance: number;
  } | null;

  /** Canonical, strategy-computed plan -- identical for every user.
   *  Each user's OWN, actually-executed entry/sl/tp (which can differ
   *  slightly due to per-user slippage on fill) lives in that user's
   *  own UserSignalDoc instead. */
  entry: number | null;
  tp: number | null;
  sl: number | null;
  rr: number | null;

  btcSafetyStatus: "CLEAN" | "WOULD_BLOCK" | "UNKNOWN" | "N/A_BTC";
  btcIntendedSideAtSignalTime: Side | null;

  rejectionReason: string | null;

  /** Sep 9 2026 (Karo), operator-requested diagnostics-only fix --
   *  mirrors V5SignalEvent.planDiagnostics exactly (see that field's
   *  own doc comment in v5-wave.service.ts). Reuses the SAME
   *  LiquidityPlanForensics deriveV5TradePlan() already computes on
   *  both its ok=true and ok=false branches -- no reimplementation.
   *  Populated for both status="SIGNAL" and status="REJECTED_PLAN"
   *  (same construction site as `physics` above), null for every
   *  other status (episodes that never reached entry-evaluation, or
   *  the rare "episode-missing-atr" early-exit where no plan
   *  computation ever ran at all). */
  planDiagnostics: {
    intensityRaw: number;
    intensity: number;
    atr15mPct: number;
    liqBaseline: number;
    rawTpPct: number;
    wallAdjustedTpPct: number;
    wallApplied: boolean;
    rrCandidate: number;
    slCapApplied: boolean;
    slCapValue: number;
    finalTpPct: number;
    finalSlPct: number;
    structuralSoftExitPrice: number;
    structuralRiskPct: number;
    sizingRiskPct: number;
    hardStopRiskPct: number;
    liquidityStrengthP95: number;
    liquidityStrength24h: number;
    liquidityStrength: number;
    w2ToW1Ratio: number;
    exhaustionScore: number;
    w1DisplacementAtr: number;
    absorptionRaw: number;
    absorptionScore: number;
    dynamicPhysicsScore: number;
    selectedRR: number;
    tpMultiplier: number;
    slDeterminedBy: "physics" | "sizing-floor";
  } | null;

  /** Sep 8 2026 (Karo) -- REVISED (was: V5TerminalReason | "SIGNAL",
   *  which incorrectly stored EVERY plan-rejected candidate as
   *  "SIGNAL" too -- confirmed and reported during a full audit).
   *    - "SIGNAL": a real, executable plan exists (entry/tp/sl all
   *      non-null) and the strategy is now OPEN -- this is the ONLY
   *      status this project's own same-symbol MAIN lock (see
   *      market-data-orchestrator.ts's own mainSymbolLocks) and
   *      startup-hydration treat as "locked/open".
   *    - "CLOSED_TP" / "CLOSED_SL": MAIN's own canonical market-price
   *      TP/SL was touched (V5WaveService.onPriceTickForTrades()) --
   *      completely independent of any user's own Binance state, see
   *      that method's own doc comment.
   *    - "REJECTED_PLAN": evaluateSignal() produced a real event (the
   *      episode DID reach candidate-evaluation) but deriveV5TradePlan()
   *      itself rejected it (entry/tp/sl all null) -- distinct from
   *      "SIGNAL" precisely because there is no executable trade here
   *      at all, and distinct from a V5TerminalReason because this
   *      candidate DID reach entry-evaluation (unlike an episode that
   *      never became a candidate in the first place).
   *    - every other value is a V5TerminalReason (episode ended
   *      without ever reaching entry-evaluation at all). */
  status:
    | V5TerminalReason
    | "SIGNAL"
    | "CLOSED_TP"
    | "CLOSED_SL"
    | "REJECTED_PLAN";

  /** Sep 8 2026 (Karo) -- MAIN's OWN canonical close facts, set ONLY
   *  when status transitions to CLOSED_TP/CLOSED_SL via
   *  onPriceTickForTrades(). Independent of, and never written by,
   *  any user's own UserSignalDoc close (karo/artak's own Binance
   *  reconciliation touches ONLY their own per-user collection --
   *  see reconcile-user-position.usecase.ts, which never imports or
   *  references GlobalSignalRepository at all). */
  closedAt: number | null;
  closePrice: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;

  /** Sep 9 2026 (Karo), operator-requested diagnostics/research-only
   *  context -- REUSES LiquidationStatsService.getVictimStatsSnapshot()
   *  exactly as-is (see that method's own doc comment). Populated ONLY
   *  for outcomes that reached entry-evaluation (status="SIGNAL" or
   *  "REJECTED_PLAN" -- same construction site as `physics` above),
   *  never for a TERMINAL_NON_SIGNAL episode that never got that far
   *  (null there, matching `physics`'s own convention). The opposite
   *  (non-current) victim side's own values are stored here PURELY for
   *  later historical analysis -- they are NEVER read by any
   *  qualification/P95-gate/intensity/TP-SL/UNIT/BTC-block/execution
   *  logic anywhere in this project; only THIS doc's own `entry`/`tp`/
   *  `sl`/`physics` fields (already computed from the CURRENT victim's
   *  own regime, unaffected by this field's existence) drive the real
   *  trade. Telegram output is intentionally unchanged -- this is a
   *  persisted-record-only enrichment. */
  liquidationStatsContext: {
    currentVictim: Side;
    long: {
      p95: number;
      baselinePerMin: number | null;
      sampleCount: number;
      source: "VICTIM_SPECIFIC" | "COMBINED_FALLBACK";
    };
    short: {
      p95: number;
      baselinePerMin: number | null;
      sampleCount: number;
      source: "VICTIM_SPECIFIC" | "COMBINED_FALLBACK";
    };
  } | null;

  /** Sep 8 2026 (Karo) -- GLOBAL research observations, NEVER
   *  per-user (see research-checkpoint.model.ts's own doc comment).
   *  Grouped by anchor since a single episode has exactly ONE anchor
   *  group in practice (SIGNAL supersedes EXHAUSTION_CANDIDATE for
   *  the same signalId -- see ResearchCheckpointTracker.registerWatch).
   *  Populated incrementally as each of the 5 sparse offsets
   *  completes -- absent/empty until the first one fires, and never
   *  fully populated for episodes still in progress. */
  researchCheckpoints: ResearchCheckpointGroup[];

  /** Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
   *  comparison. NEVER read by any production entry/execution/Telegram
   *  path -- see unit-research-shadow.service.ts's own doc comment for
   *  the full isolation guarantee. Filled in progressively, over time,
   *  by the shadow trackers (entry/no-entry summary written as soon as
   *  the shadow episode reaches a terminal state; checkpoints appended
   *  as each of the shadow's own [30s,1m,3m,5m,15m,30m] offsets
   *  completes) -- absent/partial until then, exactly like
   *  researchCheckpoints above. */
  unitResearch: {
    atr3m: UnitResearchCandidateDoc | null;
    atr5m: UnitResearchCandidateDoc | null;
  } | null;

  /** Sep 10 2026 (Karo), operator-requested LIVE 3-way ATR-unit
   *  "dragon" competition -- COMPLETELY SEPARATE from unitResearch
   *  above (different formula: no exhaustion, no absorption, no
   *  ATR15m, descending-RR-search 2.5->2.1, 0.20-0.50% SL band, no
   *  clamp/floor). NEVER read by any production entry/execution/
   *  Telegram path -- see unit-research-shadow.service.ts's own doc
   *  comment for the isolation guarantee. Filled in progressively as
   *  each of the three candidates (1m/3m/5m) independently reaches
   *  its own terminal state. */
  unitCompetitionResearch: {
    atr1m: UnitCompetitionCandidateDoc | null;
    atr3m: UnitCompetitionCandidateDoc | null;
    atr5m: UnitCompetitionCandidateDoc | null;
    /** Sep 10 2026 (Karo), operator-requested MAIN-only Telegram
     *  research lifecycle. The FIRST candidate whose own Dragon PASSes
     *  for this episode -- never reassigned once set, even if a later,
     *  slower candidate also PASSes (that candidate's own result is
     *  still fully persisted above, just never becomes the winner). */
    winnerCandidate: "atr1m" | "atr3m" | "atr5m" | null;
    winnerEntryTs: number | null;
    /** Set once the winner's own hypothetical TP or SL is actually
     *  touched by live price -- null while still open. */
    winnerResult: "TP" | "SL" | null;
  } | null;

  /** Sep 10 2026 (Karo), operator-requested RESEARCH-ONLY common-horizon
   *  Wilder-ATR experiment. GENUINELY SEPARATE from unitCompetitionResearch
   *  above -- different ATR source (Wilder(240/80/48) instead of the old
   *  ATR(14) per interval, chosen so all three candidates represent
   *  roughly the same ~4h volatility horizon), explicitly versioned so
   *  old ATR(14)-based data can never be silently mixed with this.
   *  Never read by any production entry/execution/Telegram path. */
  commonHorizonResearch: {
    readonly version: "common-horizon-4h-v1";
    atr1m: CommonHorizonCandidateDoc | null;
    atr3m: CommonHorizonCandidateDoc | null;
    atr5m: CommonHorizonCandidateDoc | null;
    winnerCandidate: "atr1m" | "atr3m" | "atr5m" | null;
    winnerEntryTs: number | null;
    winnerResult: "TP" | "SL" | null;
  } | null;

  createdAt: number;
}

/** Sep 10 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
 *  comparison. Enough raw values to independently reconstruct the
 *  shadow calculation later. */
export interface UnitResearchCandidateDoc {
  readonly unitAbs: number;
  readonly entered: boolean;
  readonly entryPrice: number | null;
  readonly entryTs: number | null;
  readonly delayVsProductionMs: number | null;
  readonly noEntryReason:
    | "CANCEL_NO_SECOND_WAVE"
    | "CASCADE_NOT_SERIOUS"
    | "EPISODE_EXPIRED"
    | null;
  readonly w1: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
  } | null;
  readonly w2: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
  } | null;
  readonly planSlPct: number | null;
  readonly planTpPct: number | null;
  readonly planRr: number | null;
  readonly checkpoints: ResearchCheckpoint[];
}

/** Sep 10 2026 (Karo), operator-requested LIVE 3-way ATR-unit "dragon"
 *  competition. One candidate's own full record -- raw values only. */
export interface UnitCompetitionCandidateDoc {
  readonly candidate: "1m" | "3m" | "5m";
  readonly frozenUnitAbs: number;
  readonly frozenAtrPct: number;
  readonly episodeStartTs: number;
  readonly w1CompleteTs: number | null;
  readonly w2StartTs: number | null;
  readonly entryReadyTs: number | null;
  readonly durationMs: number | null;
  readonly episodeLiqUsdAtEntry: number | null;
  readonly liqBaselineAtEntry: number | null;
  readonly relativePressure: number | null;
  readonly pressureFactor: number | null;
  readonly rawTpPct: number | null;
  readonly rrAttempts: readonly { rr: number; slPct: number; valid: boolean }[];
  readonly selectedRR: number | null;
  readonly rawSlPct: number | null;
  readonly verdict: "PASS" | "FAIL_NO_VALID_RR" | "STRUCTURAL_CANCEL";
  readonly hypotheticalEntry: number | null;
  readonly hypotheticalTp: number | null;
  readonly hypotheticalSl: number | null;
  readonly checkpoints: ResearchCheckpoint[];
}

/** Sep 10 2026 (Karo), operator-requested RESEARCH-ONLY common-horizon
 *  Wilder-ATR experiment ("common-horizon-4h-v1"). A SINGLE, unified
 *  doc-shape covering BOTH an in-progress (TRACKING) live-phase snapshot
 *  AND a terminal (PASS/FAIL_NO_VALID_RR/STRUCTURAL_CANCEL) result. */
export interface CommonHorizonCandidateDoc {
  readonly candidate: "1m" | "3m" | "5m";
  readonly atrPeriod: number;
  readonly episodeStartTs: number;
  readonly frozenUnitAbs: number;
  readonly frozenAtrPct: number;
  readonly state:
    | "TRACKING"
    | "PASS"
    | "FAIL_NO_VALID_RR"
    | "STRUCTURAL_CANCEL";

  readonly phase:
    | "WAITING_W1_RECOVERY"
    | "WAITING_W2_START"
    | "WAITING_W2_RECOVERY"
    | null;
  readonly w1: {
    anchorPrice: number;
    anchorTs: number;
    extremePrice: number;
    extremeTs: number;
    liqUsd: number;
    liqEvents: number;
  } | null;
  readonly w2: {
    anchorPrice: number;
    anchorTs: number;
    extremePrice: number;
    extremeTs: number;
    liqUsd: number;
    liqEvents: number;
  } | null;
  readonly currentPrice: number | null;
  readonly nextTargetPrice: number | null;
  readonly nextTargetDescription: string | null;
  readonly lastUpdatedTs: number | null;

  readonly terminalReason: string | null;
  readonly w1CompleteTs: number | null;
  readonly w2StartTs: number | null;
  readonly entryReadyTs: number | null;
  readonly durationMs: number | null;
  readonly episodeLiqUsdAtEntry: number | null;
  readonly liqBaselineAtEntry: number | null;
  readonly relativePressure: number | null;
  readonly pressureFactor: number | null;
  readonly rawTpPct: number | null;
  readonly rrAttempts: readonly { rr: number; slPct: number; valid: boolean }[];
  readonly selectedRR: number | null;
  readonly rawSlPct: number | null;
  readonly hypotheticalEntry: number | null;
  readonly hypotheticalTp: number | null;
  readonly hypotheticalSl: number | null;
  readonly checkpoints: ResearchCheckpoint[];
}

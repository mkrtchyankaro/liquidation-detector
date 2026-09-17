import type { Side } from "../../shared/common.types";

/**
 * Sep 17 2026 (Karo), operator-approved lifecycle correction, Phase
 * 3/6/7.
 *
 * CORE THESIS: post-episode OI creation + favorable reversal price
 * movement, together, is entry evidence. Neither alone is sufficient:
 *   - OI creation with NO favorable price move is not evidence of
 *     genuine reversal positioning.
 *   - Favorable price move with NO OI creation could be a thin,
 *     unsupported bounce.
 *   - OI merely stabilizing, flat, or destruction slowing is NEVER
 *     sufficient BY ITSELF -- this module requires strictly POSITIVE
 *     creation above a threshold, not "less negative than before".
 *
 * NO TIMEOUT HERE BY DESIGN -- this module is stateless/pure and is
 * called every qualifying tick for as long as the caller keeps the
 * symbol in WAIT_FOR_POST_EPISODE_OI_CREATION. The XRP-type case
 * (genuine OI creation starting several 1m candles after episode end)
 * is protected simply by NEVER cancelling this state on a timer.
 *
 * Thresholds below are new (there was no post-episode OI creation
 * concept before this change) and are explicitly UNTUNED, matching
 * this project's own established convention for every other
 * not-yet-calibrated constant.
 */

export const MIN_POST_EPISODE_OI_CREATION_FRACTION_OF_DESTROYED = 0.02; // UNTUNED
export const MIN_FAVORABLE_PRICE_MOVE_ATR_SINCE_EPISODE_END = 0.05; // UNTUNED

export interface PostEpisodeOiCreationInput {
  candidateSide: Side;
  episodeEndOiQuantity: number | null;
  currentOiQuantity: number | null;
  episodeStartOiQuantity: number | null;
  episodeMinOiQuantity: number | null;
  episodeEndPrice: number;
  currentPrice: number;
  atr3m: number | null;
}

export type PostEpisodeNoEntryReasonCode =
  | "OI_BASELINE_UNAVAILABLE"
  | "NO_POSITIVE_OI_CREATION"
  | "OI_CREATION_BELOW_THRESHOLD"
  | "NO_FAVORABLE_PRICE_MOVE"
  | "ATR_NOT_READY";

export interface PostEpisodeOiCreationResult {
  qualifies: boolean;
  reasonCode: PostEpisodeNoEntryReasonCode | null;
  detail: string;
  postEpisodeOiCreationQuantity: number | null;
  favorablePriceMoveAtr: number | null;
}

function destroyedOiMagnitude(
  startOi: number | null,
  minOi: number | null,
): number | null {
  if (startOi === null || minOi === null) return null;
  return Math.max(0, startOi - minOi);
}

export function evaluatePostEpisodeOiCreation(
  input: PostEpisodeOiCreationInput,
): PostEpisodeOiCreationResult {
  if (input.atr3m === null || input.atr3m <= 0) {
    return {
      qualifies: false,
      reasonCode: "ATR_NOT_READY",
      detail: `atr3m=${input.atr3m}`,
      postEpisodeOiCreationQuantity: null,
      favorablePriceMoveAtr: null,
    };
  }
  if (input.episodeEndOiQuantity === null || input.currentOiQuantity === null) {
    return {
      qualifies: false,
      reasonCode: "OI_BASELINE_UNAVAILABLE",
      detail: "no episode-end OI baseline or no current OI sample yet",
      postEpisodeOiCreationQuantity: null,
      favorablePriceMoveAtr: null,
    };
  }

  const creation = input.currentOiQuantity - input.episodeEndOiQuantity;
  if (creation <= 0) {
    return {
      qualifies: false,
      reasonCode: "NO_POSITIVE_OI_CREATION",
      detail: `postEpisodeOiCreationQuantity=${creation.toFixed(2)} <= 0 -- flat or still falling is never sufficient`,
      postEpisodeOiCreationQuantity: creation,
      favorablePriceMoveAtr: null,
    };
  }

  const destroyed = destroyedOiMagnitude(
    input.episodeStartOiQuantity,
    input.episodeMinOiQuantity,
  );
  const requiredCreation =
    destroyed !== null && destroyed > 0
      ? destroyed * MIN_POST_EPISODE_OI_CREATION_FRACTION_OF_DESTROYED
      : null;
  if (requiredCreation !== null && creation < requiredCreation) {
    return {
      qualifies: false,
      reasonCode: "OI_CREATION_BELOW_THRESHOLD",
      detail: `postEpisodeOiCreationQuantity=${creation.toFixed(2)} < required=${requiredCreation.toFixed(2)} (${(MIN_POST_EPISODE_OI_CREATION_FRACTION_OF_DESTROYED * 100).toFixed(0)}% of destroyed=${destroyed!.toFixed(2)})`,
      postEpisodeOiCreationQuantity: creation,
      favorablePriceMoveAtr: null,
    };
  }

  const favorableMove =
    input.candidateSide === "LONG"
      ? input.currentPrice - input.episodeEndPrice
      : input.episodeEndPrice - input.currentPrice;
  const favorableMoveAtr = favorableMove / input.atr3m;
  if (favorableMoveAtr < MIN_FAVORABLE_PRICE_MOVE_ATR_SINCE_EPISODE_END) {
    return {
      qualifies: false,
      reasonCode: "NO_FAVORABLE_PRICE_MOVE",
      detail: `favorablePriceMoveAtr=${favorableMoveAtr.toFixed(3)} < required=${MIN_FAVORABLE_PRICE_MOVE_ATR_SINCE_EPISODE_END} -- OI creation alone is not sufficient`,
      postEpisodeOiCreationQuantity: creation,
      favorablePriceMoveAtr: favorableMoveAtr,
    };
  }

  return {
    qualifies: true,
    reasonCode: null,
    detail: `postEpisodeOiCreationQuantity=${creation.toFixed(2)}, favorablePriceMoveAtr=${favorableMoveAtr.toFixed(3)}`,
    postEpisodeOiCreationQuantity: creation,
    favorablePriceMoveAtr: favorableMoveAtr,
  };
}

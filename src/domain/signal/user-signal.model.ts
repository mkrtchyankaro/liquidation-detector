import type { Side } from "../../shared/common.types";

/**
 * Sep 8 2026 (Karo). One document per (userId, signalId) -- but note
 * userId itself is NOT a field here: per explicit operator
 * instruction, each user has their OWN, independent Mongo collection
 * (`v5_signals_<userId>`, see mongo.client.ts's own userSignals()),
 * not one shared collection with a userId column. This is the
 * "USER SIGNAL / DELIVERY STATE" half of the split described in the
 * approved architecture -- independent of every other user's own
 * document for the SAME signalId.
 */
export type UserSignalStatus =
  | "TELEGRAM_ONLY" // execution disabled/not attempted for this user -- Telegram (if enabled) still sent
  | "NOT_EXECUTED" // execution was attempted-eligible but did not result in a live position (e.g. daily-loss-limit block, pre-flight rejection)
  | "EXECUTION_FAILED" // a real execution attempt threw/errored
  | "BTC_BLOCKED" // this user's own btcBlockEnabled=true, and BTC currently has an active same-side setup (or this IS BTC's own signal) -- neither Telegram nor execution ran at all
  | "DIRECTION_DISABLED" // this user's own longEnabled/shortEnabled=false for this signal's side -- neither Telegram nor execution ran at all
  | "OPEN" // this user has a real, live Binance position for this signal
  | "CLOSED_TP"
  | "CLOSED_SL"
  | "CLOSED_MANUAL"; // Binance position closed but neither this user's own SL nor TP order filled (manual close, or ambiguous)

export interface UserSignalDoc {
  signalId: string;
  symbol: string;
  side: Side;

  telegramSent: boolean;
  telegramSentAt: number | null;

  executionEnabled: boolean; // snapshot of this user's own config at signal time
  status: UserSignalStatus;

  isLive: boolean;
  binanceSlOrderId: number | null;
  binanceTpOrderId: number | null;
  positionQty: number | null;
  notional: number | null;
  riskUsd: number | null;

  /** This user's OWN actual entry/sl/tp -- can differ slightly from
   *  the GlobalSignalDoc's own canonical values due to per-user
   *  slippage on fill (post-fill replan, see BinanceExecutionService). */
  entry: number | null;
  sl: number | null;
  tp: number | null;

  closedAt: number | null;
  closePrice: number | null;
  closeReason: "TP" | "SL" | "MANUAL" | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;

  createdAt: number;
  updatedAt: number;
}

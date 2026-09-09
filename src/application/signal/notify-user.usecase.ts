import type { GlobalSignalDoc } from "../../domain/signal/global-signal.model";
import type { UserRuntime } from "../../services/user-runtime";
import { formatV5EntryMessage } from "../../infrastructure/telegram/signal.formatter";
import { childLogger } from "../../infrastructure/logging/logger";
import type { V5SignalEvent } from "../../strategy/v5/v5-wave.service";

const log = childLogger({ mod: "notify-user" });

/** Sep 8 2026 (Karo). CRITICAL FIX: formatV5EntryMessage expects a
 *  V5SignalEvent shape, whose `plan` is a NESTED object
 *  ({entry,tp,sl,rr,...}) -- but GlobalSignalDoc stores those same
 *  values as FLAT top-level fields (entry/tp/sl/rr) plus a SEPARATE
 *  `physics` object, and has NO `.plan` property at all. The previous
 *  `globalSignal as unknown as V5SignalEvent` cast left `event.plan`
 *  simply `undefined` on every message: the formatter's own
 *  `event.plan !== null` check (for the emoji/header) evaluated true
 *  (undefined !== null), showing "🟢 ENTRY", while its SEPARATE
 *  `if (event.plan)` check (for which fields to render) evaluated
 *  false (undefined is falsy) -- silently rendering the REJECTED
 *  branch instead, which reads event.entryPrice/event.rejectionReason
 *  only. The real entry/SL/TP/RR/position-size were never missing
 *  from the DATA (globalSignal.entry/tp/sl/rr were always correct) --
 *  only the message never read them, for every single live/executed
 *  signal since this project's very first deploy. Confirmed via a
 *  real production message: header said "ENTRY" with a real reclaim
 *  price, body said "Plan rejected: unknown" and showed no SL/TP/Risk
 *  at all. Fixed by explicitly reconstructing the nested `plan` shape
 *  the formatter actually expects, from GlobalSignalDoc's own already-
 *  correct flat fields -- no data was ever lost, only mis-displayed. */
function toV5SignalEventShape(doc: GlobalSignalDoc): V5SignalEvent {
  const plan =
    doc.entry !== null &&
    doc.tp !== null &&
    doc.sl !== null &&
    doc.rr !== null &&
    doc.physics !== null
      ? {
          entry: doc.entry,
          tp: doc.tp,
          sl: doc.sl,
          rr: doc.rr,
          liqStrengthRaw: doc.physics.liqStrengthRaw,
          liqStrength: doc.physics.liqStrength,
          liqBaseline: doc.physics.liqBaseline,
          physicsTPPct: doc.physics.physicsTPPct,
          wallAdjustedTpPct: doc.physics.wallAdjustedTpPct,
          wallApplied: doc.physics.wallApplied,
          rrCandidate: doc.physics.rrCandidate,
          slCapApplied: doc.physics.slCapApplied,
          slCapValue: doc.physics.slCapValue,
          finalTpPct: doc.physics.finalTpPct,
          finalSlPct: doc.physics.finalSlPct,
          structuralSoftExitPrice: doc.physics.structuralSoftExitPrice,
          structuralRiskPct: doc.physics.structuralRiskPct,
          sizingRiskPct: doc.physics.sizingRiskPct,
          hardStopRiskPct: doc.physics.hardStopRiskPct,
          liquidityStrengthP95: doc.physics.liquidityStrengthP95,
          liquidityStrength24h: doc.physics.liquidityStrength24h,
          liquidityStrength: doc.physics.liquidityStrength,
          w2ToW1Ratio: doc.physics.w2ToW1Ratio,
          exhaustionScore: doc.physics.exhaustionScore,
          w1DisplacementAtr: doc.physics.w1DisplacementAtr,
          absorptionRaw: doc.physics.absorptionRaw,
          absorptionScore: doc.physics.absorptionScore,
          dynamicPhysicsScore: doc.physics.dynamicPhysicsScore,
          selectedRR: doc.physics.selectedRR,
          tpMultiplier: doc.physics.tpMultiplier,
          slDeterminedBy: doc.physics.slDeterminedBy,
        }
      : null;
  return { ...(doc as unknown as V5SignalEvent), plan };
}

/** Sep 8 2026 (Karo). formatV5EntryMessage is REUSED, byte-identical,
 *  from liqwatch-bot's own strategy-v2/v5/v5-signal.formatter.ts. It
 *  takes a V5SignalEvent shape; globalSignal (GlobalSignalDoc) already
 *  carries every field that formatter needs, once correctly reshaped
 *  (see toV5SignalEventShape's own doc comment for the exact bug this
 *  fixes). */
export async function notifyUser(
  globalSignal: GlobalSignalDoc,
  runtime: UserRuntime,
): Promise<boolean> {
  if (!runtime.telegram || !runtime.config.telegram?.enabled) return false;
  try {
    const message = formatV5EntryMessage(toV5SignalEventShape(globalSignal));
    await runtime.telegram.sendMessage(message);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err: msg,
        userId: runtime.config.userId,
        signalId: globalSignal.signalId,
      },
      "[USER_TELEGRAM_SEND_FAILED] -- isolated, other users unaffected",
    );
    return false;
  }
}

export async function notifyUserClose(
  message: string,
  runtime: UserRuntime,
): Promise<void> {
  if (!runtime.telegram || !runtime.config.telegram?.enabled) return;
  try {
    await runtime.telegram.sendMessage(message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: msg, userId: runtime.config.userId },
      "[USER_TELEGRAM_CLOSE_SEND_FAILED]",
    );
  }
}

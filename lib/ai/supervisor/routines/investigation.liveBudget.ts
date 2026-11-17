import {standardModelTokenRates} from "@/lib/calc/supervisorTokenCost";

/** Trusted acceptance-only conservative transport reservation for Task 15A.
 * This caps disposable real-model tests; it is NOT a production billing view.
 * The live runner does not replay an already failed provider request.
 *
 * The bound rates MUST come from the existing model-specific standard
 * pricing helper; only the exact pre-approved gpt-6-luna production model
 * is permitted. Unknown or changed model/tier fails before transport.
 * Treat every serialized UTF-8 byte as an input token (no cache discount)
 * and reserve prior output caps as extra replayable context.
 */
export const INVESTIGATION_LIVE_MAX_CALLS=12;
export const INVESTIGATION_LIVE_MAX_BYTES=600_000;
export const INVESTIGATION_LIVE_MAX_OUTPUT_PER_CALL=1200;
export const INVESTIGATION_LIVE_MAX_RESERVED_MICROS=80_000;

export type InvestigationLiveLedger=Readonly<{
  calls:number;bytes:number;reservedMicros:number;
}>;

export function emptyInvestigationLiveLedger():InvestigationLiveLedger{
  return {calls:0,bytes:0,reservedMicros:0};
}

export function reserveInvestigationLiveCall(
  used:InvestigationLiveLedger,serializedBytes:number,outputCap:number,model:string,
):InvestigationLiveLedger{
  if(!Number.isSafeInteger(used.calls)||used.calls<0||
     !Number.isSafeInteger(used.bytes)||used.bytes<0||
     !Number.isSafeInteger(used.reservedMicros)||used.reservedMicros<0||
     !Number.isSafeInteger(serializedBytes)||serializedBytes<1||
     !Number.isSafeInteger(outputCap)||outputCap<1||
     outputCap>INVESTIGATION_LIVE_MAX_OUTPUT_PER_CALL)
    throw new Error("15a_live_invalid_budget");
  // A system misconfiguration must never bill an unpriced/fallback model
  // against Luna's much smaller reservation. The trusted workflow selects
  // the same known production model; unknown snapshots are not guessed.
  const rates=model==="gpt-6-luna"?
    standardModelTokenRates(model,null,serializedBytes):null;
  const inputRate=Number(rates?.input),outputRate=Number(rates?.output);
  if(!rates?.input||!rates?.output||
     !Number.isFinite(inputRate)||!Number.isFinite(outputRate)||
     inputRate<=0||outputRate<=0)
    throw new Error("15a_live_model_unpriced_or_mismatched");
  // Each earlier response could have consumed its FULL output cap, even if
  // encrypted reasoning items are not represented as plain input text.
  const extraReplayOutputTokens=used.calls*INVESTIGATION_LIVE_MAX_OUTPUT_PER_CALL;
  const nextReservation=Math.ceil(serializedBytes*inputRate+
    extraReplayOutputTokens*inputRate+outputCap*outputRate);
  const next={calls:used.calls+1,bytes:used.bytes+serializedBytes,
    reservedMicros:used.reservedMicros+nextReservation};
  if(next.calls>INVESTIGATION_LIVE_MAX_CALLS||
     next.bytes>INVESTIGATION_LIVE_MAX_BYTES||
     next.reservedMicros>INVESTIGATION_LIVE_MAX_RESERVED_MICROS)
    throw new Error("15a_live_provider_budget_exceeded");
  return next;
}

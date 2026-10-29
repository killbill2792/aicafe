"use server";

import {cafeToday} from "@/lib/metrics/core/clock";
import {getSnapshot} from "@/lib/data/getSnapshot";
import { isAiConfigured } from "@/lib/ai/types";
import {requireOwnerAccessScope} from "@/lib/access/access.server";
import {getTranslations} from "next-intl/server";
import { parseVoiceExpense, type VoiceExpenseResult } from "@/lib/ai/prompts/voiceExpense";

export type VoiceReviewResult = { ok: true; expense: VoiceExpenseResult } | { ok: false; error: string };

/** "Say it" (docs/03-screens.md S10). `transcript` comes from the browser's speech recognition. */
export async function reviewVoiceExpense(transcript: string): Promise<VoiceReviewResult> {
  // The /add-cost/voice page already gates on isAiConfigured() before this ever mounts — this
  // stays as a defensive fallback, never leaking anything about env vars or API keys to the owner.
  if (!isAiConfigured()) return { ok: false, error: (await getTranslations("AddCost"))("voiceUnavailable") };
  if (!transcript.trim()) return { ok: false, error: (await getTranslations("AddCost"))("voiceNoTranscript") };

  let owner:Awaited<ReturnType<typeof requireOwnerAccessScope>>;
  try{owner=await requireOwnerAccessScope();}
  catch{return {ok:false,error:(await getTranslations("AddCost"))("voiceAuthRequired")};}
  if(!owner.access.active){
    const t=await getTranslations("FreeAccess");
    return {ok:false,error:t("expired")};
  }
  // Use the same authenticated/fixture snapshot as the screen. Never fall back to UTC.
  const snapshot=await getSnapshot();
  const today=cafeToday(snapshot.business.timezone);

  try {
    const expense = await parseVoiceExpense(transcript, today);
    return { ok: true, expense };
  } catch {
    console.error("voice_review_failed");
    return { ok: false, error: (await getTranslations("AddCost"))("voiceParseFailed") };
  }
}

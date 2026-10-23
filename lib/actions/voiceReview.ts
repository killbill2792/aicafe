"use server";

import { formatInTimeZone } from "date-fns-tz";
import { isAiConfigured } from "@/lib/ai/types";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
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
  let today = new Date().toISOString().slice(0, 10);
  if (isSupabaseConfigured()) {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const businessId = await getActiveBusinessId(user.id);
      const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
      if (business?.timezone) today = formatInTimeZone(new Date(), business.timezone, "yyyy-MM-dd");
    }
  }

  try {
    const expense = await parseVoiceExpense(transcript, today);
    return { ok: true, expense };
  } catch {
    console.error("voice_review_failed");
    return { ok: false, error: (await getTranslations("AddCost"))("voiceParseFailed") };
  }
}

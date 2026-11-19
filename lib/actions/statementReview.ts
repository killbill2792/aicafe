"use server";

import { createHash } from "node:crypto";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { simulationOwnerReader } from "@/lib/ai/supervisor/loop/simulationOwner.server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { parseStatementCsv } from "@/lib/expenses/parseStatementCsv";
import {getCafeAccess} from "@/lib/access/access.server";
import { categorizeLines } from "@/lib/expenses/categorize";
import type { ReviewLine } from "./expenses";

export type StatementReviewResult =
  | { ok: true; lines: ReviewLine[]; balanceCheck: ReturnType<typeof parseStatementCsv>["balanceCheck"]; unrecognizedColumns: boolean; currency?: string | null; cashEvidence?: { sourceHash: string; asOf: string; closingCents: number } | null }
  | { ok: false; error: string };

/** Parses an uploaded CSV, skips excluded lines, categorizes the rest (docs/03-screens.md S10). */
export async function reviewStatementCsv(csvText: string): Promise<StatementReviewResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Sign in and connect Supabase to categorize a statement." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const businessId = await getActiveBusinessId(user.id);

  if(typeof csvText!=="string"||csvText.length>1_000_000)return {ok:false,error:"Statement file is too large."};
  const access=await getCafeAccess(businessId);
  const parsed = parseStatementCsv(csvText);
  if(parsed.sourceErrors||parsed.unrecognizedColumns||parsed.invalidRows.length) return {ok:false,error:"The statement contains unrecognized columns or invalid transaction rows. Correct the source file and retry."};
  if (parsed.lines.length === 0) return { ok: false, error: "No transaction lines were found in that file." };

  // Only money-out lines get categorized (docs/06-integrations.md step 4: skip deposits/transfers
  // outright rather than sending them to the AI at all).
  const moneyOutLines = parsed.lines.filter((l) => l.amountCents < 0);
  const categorized = await categorizeLines(
    supabase,
    businessId,
    moneyOutLines.map((l) => ({ i: l.i, date: l.date, description: l.description, amount: l.amountCents / 100 })),
    access.active,
  );

  const byIndex = new Map(moneyOutLines.map((l) => [l.i, l]));
  const lines: ReviewLine[] = categorized
    .map((c) => {
      const original = byIndex.get(c.i);
      if (!original) return null;
      return {
        i: c.i,
        date: original.date,
        description: c.vendor || original.description,
        amountCents: Math.abs(original.amountCents),
        category: c.category,
        reason: c.reason,
        confidence: c.confidence,
      };
    })
    .filter((l): l is ReviewLine => l !== null);

  const {data:business}=await supabase.from("businesses").select("currency").eq("id",businessId).maybeSingle();
  const currency=typeof business?.currency==="string"&&/^[A-Z]{3}$/.test(business.currency)?business.currency:null;
  return {ok:true,lines,balanceCheck:parsed.balanceCheck,unrecognizedColumns:parsed.unrecognizedColumns,currency,
   cashEvidence:currency&&parsed.statementEvidence&&parsed.statementEvidence.transactions.length<=10000?
    {sourceHash:hash(csvText),asOf:parsed.statementEvidence.to,closingCents:parsed.statementEvidence.closingCents}:null};
}

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");

/** Direct authenticated owner confirmation, NOT a model action or bank verification.
 * Reparse source; never trust edited expense rows, a client balance or a currency guess. */
export async function saveConfirmedStatementEvidence(input:{csvText:string;sourceHash:string;accountAlias:string;currency:string;confirmed:boolean}):Promise<{ok:true;uploadId:string}|{ok:false;error:string}>{
 const failed={ok:false as const,error:"Could not save historical cash evidence. Check the statement and account nickname."};
 try{
  if(!input||input.confirmed!==true||typeof input.csvText!=="string"||input.csvText.length>1_000_000||
   typeof input.accountAlias!=="string"||typeof input.currency!=="string"||!isSupabaseConfigured())return failed;
  const alias=input.accountAlias.trim().toLowerCase().replace(/\s+/g," ");
  if(!/^[a-z][a-z -]{1,59}$/.test(alias)||hash(input.csvText)!==input.sourceHash)return failed;
  const parsed=parseStatementCsv(input.csvText),e=parsed.statementEvidence;
  if(!e||e.transactions.length>10000||parsed.sourceErrors||parsed.invalidRows.length)return failed;
  const session=await createServerSupabaseClient();
  const {data:{user},error}=await session.auth.getUser();
  if(error||!user)return failed;
  const businessId=await getActiveBusinessId(user.id),scope={businessId,ownerUserId:user.id};
  const {client}=await simulationOwnerReader(scope);
  const {data:business}=await client.from("businesses").select("currency").eq("id",businessId).maybeSingle();
  if(!business||business.currency!==input.currency||!/^[A-Z]{3}$/.test(input.currency))return failed;
  const accountKey=hash(JSON.stringify([businessId,user.id,alias]));
  const {data:uploadId,error:writeError}=await createAdminSupabaseClient().rpc("supervisor_record_statement_evidence",{
   p_business_id:businessId,p_owner_user_id:user.id,p_source_sha256:input.sourceHash,p_account_key:accountKey,
   p_currency:input.currency,p_from:e.from,p_to:e.to,p_opening_cents:e.openingCents,
   p_closing_cents:e.closingCents,p_transactions:e.transactions});
  if(writeError||typeof uploadId!=="string")return failed;
  await simulationOwnerReader(scope);
  const {data:receipt,error:readError}=await client.from("uploads").select("id,financial_source_sha256,financial_account_key,financial_to,financial_closing_cents")
   .eq("business_id",businessId).eq("financial_owner_user_id",user.id).eq("id",uploadId).maybeSingle();
  if(readError||!receipt||receipt.financial_source_sha256!==input.sourceHash||receipt.financial_account_key!==accountKey||
   receipt.financial_to!==e.to||Number(receipt.financial_closing_cents)!==e.closingCents)return failed;
  return {ok:true,uploadId};
 }catch{return failed;}
}

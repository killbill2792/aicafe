import "server-only";

import { z } from "zod";
import { requireSchedulingOwner } from "./foundation.server";

declare const ownerActionBrand: unique symbol;
/** Process-local, non-serializable capability. Never part of a model/JSON tool. */
export type OliviaOwnerActionProof = Readonly<{[ownerActionBrand]:true}>;
type Claim={businessId:string;actorId:string;digest:string;requestKey:string;expires:number};
const claims=new WeakMap<object,Claim>();
const requestSchema=z.object({
  proposalDigest:z.string().regex(/^[a-f0-9]{64}$/),
  requestKey:z.string().uuid(),
}).strict();

/**
 * PRIVATE TRUSTED UI BOUNDARY for a future owner-confirm control.
 * The calling handler MUST require a fresh, deliberate owner UI submit after
 * displaying the exact proposal (digest + employee/date/source summary).
 * NEVER expose this issuer through AI tools, a model dispatcher, or a generic
 * route that accepts a model "confirmed" flag. PR4B-A adds NO such route.
 */
export async function attestOliviaOwnerActionFromTrustedUI(raw:unknown):Promise<
  |{ok:true;proof:OliviaOwnerActionProof}
  |{ok:false;error:"invalid_input"|"unauthorized"}
>{
  const parsed=requestSchema.safeParse(raw);
  if(!parsed.success)return {ok:false,error:"invalid_input"};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false,error:"unauthorized"};
  const auth=await owner.supabase.auth.getUser();
  if(auth.error || !auth.data.user)return {ok:false,error:"unauthorized"};
  const proof=Object.freeze({}) as OliviaOwnerActionProof;
  claims.set(proof,{businessId:owner.businessId,actorId:auth.data.user.id,
    digest:parsed.data.proposalDigest,requestKey:parsed.data.requestKey,
    expires:Date.now()+5*60_000});
  return {ok:true,proof};
}

/** Single-use even on error. Replays need a new separately verified action. */
export function consumeOliviaOwnerActionProof(
  proof:unknown,businessId:string,actorId:string,digest:string,requestKey:string,
):boolean {
  if(!proof || typeof proof!=="object")return false;
  const claim=claims.get(proof);
  claims.delete(proof);
  return !!claim && claim.expires>=Date.now() &&
    claim.businessId===businessId && claim.actorId===actorId &&
    claim.digest===digest && claim.requestKey===requestKey;
}

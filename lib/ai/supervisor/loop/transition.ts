import {z} from "zod";
import {createHash} from "node:crypto";
export const proposalStatus=z.enum(["draft","approved","committed","manual_pending",
  "manual_confirmed","rejected","expired"]);
export type ProposalStatus=z.infer<typeof proposalStatus>;
export const approvalReference=z.strictObject({
  proposalId:z.uuid(),revision:z.number().int().safe().positive(),
  effectHash:z.string().regex(/^[0-9a-f]{64}$/),
});
export const effectPayload=z.strictObject({
  productId:z.uuid(),field:z.literal("price_cents"),
  fromValueCents:z.number().int().safe().nonnegative(),
  toValueCents:z.number().int().safe().nonnegative(),
});
export type CanonicalEffectPayload=z.infer<typeof effectPayload>;
export const monitorSpec=z.strictObject({
  durationDays:z.number().int().min(1).max(31),
  itemId:z.uuid(),baselineFromDate:z.iso.date(),baselineToDate:z.iso.date(),
});
export type MonitorSpec=z.infer<typeof monitorSpec>;
export function effectPayloadHash(payload:unknown):string{
  const canonical=effectPayload.parse(payload);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export function allowedTransition(current:ProposalStatus,action:"approve"|"commit"|"manual_confirm"|"reject"|"expire"):ProposalStatus{
  const transitions:{[S in ProposalStatus]?:Partial<Record<typeof action,ProposalStatus>>}={
    draft:{approve:"approved",reject:"rejected",expire:"expired"},
    approved:{commit:"manual_pending",reject:"rejected",expire:"expired"},
    manual_pending:{manual_confirm:"manual_confirmed",expire:"expired"},
    manual_confirmed:{},committed:{},rejected:{},expired:{},
  };
  const next=transitions[current]?.[action];
  if(!next)throw new Error("invalid_proposal_transition");
  return next;
}

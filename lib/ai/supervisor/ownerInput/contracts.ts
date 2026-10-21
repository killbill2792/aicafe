import {z} from "zod";

/** Server-issued requests name a reviewed write capability, never SQL or code. */
const localized=z.strictObject({en:z.string().min(1).max(240),
  es:z.string().min(1).max(240),ar:z.string().min(1).max(240)});
export const ownerInputRequestSchema=z.strictObject({
  fieldId:z.string().min(1).max(120),
  writeCapabilityId:z.string().min(1).max(120),
  writeContext:z.record(z.string().min(1).max(80),z.string().max(200)),
  question:localized,
  input:z.discriminatedUnion("kind",[
    z.strictObject({kind:z.literal("free_text"),hint:localized}),
    z.strictObject({kind:z.literal("options"),options:z.array(
      z.strictObject({id:z.string().min(1).max(100),label:localized})
    ).min(2).max(30)}),
  ]),
});
export type OwnerInputRequest=z.infer<typeof ownerInputRequestSchema>;
export const ownerQuestionSchema=z.strictObject({
  type:z.literal("owner_question"),questionId:z.string().uuid(),
  title:localized,
  input:z.discriminatedUnion("kind",[
    z.strictObject({kind:z.literal("free_text"),hint:localized}),
    z.strictObject({kind:z.literal("options"),options:z.array(
      z.strictObject({id:z.string().min(1).max(100),label:localized})
    ).min(2).max(30)}),
  ]),
});
export type OwnerQuestion=z.infer<typeof ownerQuestionSchema>;
export const pendingOwnerInputSchema=z.strictObject({
  version:z.literal(1),questionId:z.string().uuid(),
  stage:z.enum(["answer","confirm"]),businessId:z.string().uuid(),
  originalText:z.string().min(1).max(4000),
  readCapabilityId:z.string().min(1).max(120),
  readInputJson:z.string().min(2).max(10000),
  request:ownerInputRequestSchema,
  answer:z.string().max(200).nullable(),
  summary:localized.nullable(),
});
export type PendingOwnerInput=z.infer<typeof pendingOwnerInputSchema>;
export const ownerInputResponseSchema=z.strictObject({
  questionId:z.string().uuid(),action:z.enum(["supply","confirm","dismiss"]),
  value:z.string().trim().max(200).optional(),
});
export type OwnerInputResponse=z.infer<typeof ownerInputResponseSchema>;
export function localizedText(copy:Record<"en"|"es"|"ar",string>,locale:"en"|"es"|"ar"){
  return copy[locale];
}

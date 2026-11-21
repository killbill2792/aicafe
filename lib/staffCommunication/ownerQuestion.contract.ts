import {z} from "zod";
/** Existing Luna proposal/effect gateway must bind these to an owner, café,
 * thread and checked source. Never accept an actor or café ID from the model. */
export const staffQuestionInput=z.strictObject({
 sourceKind:z.enum(["operating_task","alert"]),
 sourceTaskId:z.string().min(1).max(160),
 employeeId:z.uuid(),
 question:z.string().trim().min(5).max(800),
 reason:z.string().trim().min(1).max(500),
 evidence:z.array(z.strictObject({
  source:z.string().min(1).max(120),asOf:z.string().min(1).max(80),
 })).min(1).max(8),
 followUpAfter:z.iso.datetime({offset:true}),
});
export const ownerStaffQuestionDecision=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("ask"),proposalId:z.uuid(),revision:z.number().int().positive()}),
 z.strictObject({action:z.literal("ignore"),proposalId:z.uuid(),revision:z.number().int().positive()}),
]);
export type StaffQuestionDraft=z.infer<typeof staffQuestionInput>;
export type OwnerStaffQuestionDecision=z.infer<typeof ownerStaffQuestionDecision>;

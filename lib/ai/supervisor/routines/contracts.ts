import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ConversationScope} from "@/lib/ai/conversations/contracts";

/** All owner and café identities are authenticated by the server, never model inputs. */
export type VerifiedRoutineTurn={
  scope:ConversationScope;
  threadId:string;
  /** Verified current owner message, for retry-idempotent create. */
  ownerMessageId?:string;
  client:SupabaseClient;
};
export const routineScheduleSchema=z.strictObject({
  title:z.string().trim().min(1).max(240),
  cadence:z.enum(["daily","weekly"]),
  /** ISO weekdays: Monday=1 to Sunday=7. Empty for daily schedules. */
  weekdays:z.array(z.number().int().min(1).max(7)).max(7),
  localTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
}).superRefine((schedule,ctx)=>{
  if(schedule.cadence==="daily"&&schedule.weekdays.length!==0)
    ctx.addIssue({code:"custom",path:["weekdays"],message:"Daily routines cannot select weekdays"});
  if(schedule.cadence==="weekly"&&schedule.weekdays.length===0)
    ctx.addIssue({code:"custom",path:["weekdays"],message:"Weekly routines need a weekday"});
  if(new Set(schedule.weekdays).size!==schedule.weekdays.length)
    ctx.addIssue({code:"custom",path:["weekdays"],message:"Repeated weekday"});
});
export type RoutineSchedule=z.infer<typeof routineScheduleSchema>;
export const routineIdSchema=z.uuid();
export const routineStatusSchema=z.enum(["active","paused","revoked"]);
export type RoutineStatus=z.infer<typeof routineStatusSchema>;
export type RoutineRecord=RoutineSchedule & {
  id:string;businessId:string;ownerUserId:string;threadId:string;
  timezone:string;status:RoutineStatus;revision:number;
  createdAt:string;updatedAt:string;
};
export type RoutineOccurrence={
  businessId:string;routineId:string;localDate:string;runId:string;
  scheduledForUtc:string;state:"pending"|"running"|"completed"|"failed";
  attempts:number;receiptRef:string|null;lastError:string|null;
};
export type PrioritySource={
  businessId:string;ownerUserId:string;
  sourceType:"alert"|"operating_task";sourceId:string;
  kind:string;status:string;createdAt:string;dueAt?:string|null;
  confidence?:string|null;severity?:string|null;
  evidence?:unknown;dedupeKey?:string|null;
};
export type PriorityDecision={
  source:PrioritySource;revisionHash:string;priority:number;
  reason:string;stableKey:string;
};

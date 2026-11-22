import type {StaffMessage} from "./channel.server";
import type {CrewSubmissionReceipt,PendingCrewSubmission} from "./pendingSend";

/** A POST acknowledgement is a verified RPC receipt, not an optimistic click.
 * Keep only the current signed-in worker's own confirmed submission on screen
 * while a Next.js server-component refresh catches up. Never invent a row for
 * an unconfirmed, stale, or failed send. */
export type VerifiedCrewMessage={authUserId:string;message:StaffMessage};
export function confirmedCrewMessage(
 authUserId:string,
 operation:Readonly<PendingCrewSubmission>,
 receipt:Readonly<CrewSubmissionReceipt>,
 receivedAt:string,
):VerifiedCrewMessage{
 return {authUserId,message:{
  id:receipt.id,request_id:operation.requestId,response_code:operation.response,
  body:operation.body,channel:"web",received_at:receivedAt,actor:"employee",
 }};
}
/** Server-backed history remains authoritative for matching IDs. A
 * confirmed current-user receipt fills only the temporary RSC gap. */
export function visibleCrewHistory(
 authUserId:string,
 serverMessages:readonly StaffMessage[],
 confirmed:readonly VerifiedCrewMessage[],
):StaffMessage[]{
 const scoped=confirmed.filter(m=>m.authUserId===authUserId);
 const serverIds=new Set(serverMessages.map(m=>m.id));
 const pending=new Map<string,StaffMessage>();
 for(const entry of scoped)if(!serverIds.has(entry.message.id))pending.set(entry.message.id,entry.message);
 return [...pending.values(),...serverMessages];
}

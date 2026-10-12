import type { OperatingTask } from "@/lib/operating/tasks";

/** A URL task identifier is only a presentation hint. It must already belong
 * to the authenticated business, selected agent, and visible status inbox. */
export function selectedInboxTaskId(
  visibleTasks:readonly Pick<OperatingTask,"id">[],
  requestedId:string|undefined,
):string|null {
  return typeof requestedId==="string"&&requestedId.length<=200
    ? visibleTasks.find(task=>task.id===requestedId)?.id??null:null;
}

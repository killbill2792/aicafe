import type {EvidenceReference,SupervisorReplyBlock} from "@/lib/ai/conversations/contracts";
import {values} from "@/lib/metrics/p1Catalog";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
/** Domain-owned presentation of schema-validated persisted tasks. No model
 * supplies a URL, task ID, status, agent or title, and no action is executed. */
export function presentInvestigatedTasks(sourceContract:string|undefined,value:unknown,
  source:EvidenceReference,locale:"en"|"es"|"ar"):SupervisorReplyBlock[]{
  if(sourceContract!=="team.tasks")return [];
  const rows=Array.isArray(value)?value:value&&typeof value==="object"&&"items" in value?value.items:[];
  if(!Array.isArray(rows))return [];
  const labels={en,es,ar}[locale].SupervisorChat;
  const titles={price_review:labels.taskPrice,staff_coverage:labels.taskStaff,supply_check:labels.taskSupply,
    money_update:labels.taskMoney,data_quality:labels.taskData};
  const output:SupervisorReplyBlock[]=[];
  for(const row of rows){
    const parsed=values["team.tasks"].shape.items.element.safeParse(row);
    if(!parsed.success||parsed.data.id.length>200||parsed.data.status==="expired")continue;
    const task=parsed.data;
    const tab=task.status==="handled"?"handled":task.status==="watching"?"watching":"needs_you";
    const query=new URLSearchParams({status:tab,agent:task.agentId,task:task.id});
    output.push({type:"task_card",taskId:task.id,agent:task.agentId,title:titles[task.kind],status:task.status,
      href:"/operations?"+query.toString()+"#selected-task",source});
    if(output.length===3)break;
  }
  return output;
}

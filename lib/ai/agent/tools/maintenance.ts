import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/**
 * Read the SAME persisted maintenance cases shown in Operations/Home.
 * This is not a model-created registry and has NO write/effect authority.
 */
export const maintenanceTools={
  get_maintenance_cases:{
    agentId:"leo",schema:z.strictObject({}),
    description:"Read saved maintenance cases, equipment reports, follow-up blockers and independently verified repair state for this authenticated café. This is read only. Never interpret vendor send, owner report, repair claim or spending as completed without the corresponding source receipt.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      maintenanceTools.get_maintenance_cases.schema.parse(raw);
      if(!ctx.canonicalData||!ctx.threadId)
        return {source:"maintenance_cases",period:null,agentId:"leo",
          missing:["maintenance_source_unavailable"],cases:[]};
      try{
        const {db,businessId}=await ctx.canonicalData();
        // External turns use a privileged client. Resolve the owner from the
        // server-bound conversation, never from model arguments or café alone.
        const thread=await db.from("ai_threads").select("owner_user_id")
          .eq("business_id",businessId).eq("id",ctx.threadId).maybeSingle();
        const ownerId=thread.data?.owner_user_id;
        if(thread.error||!ownerId)throw new Error("maintenance_scope_unavailable");
        const member=await db.from("memberships").select("role")
          .eq("business_id",businessId).eq("user_id",ownerId).maybeSingle();
        if(member.error||member.data?.role!=="owner")throw new Error("maintenance_scope_unavailable");
        const cases=await db.from("operating_tasks")
          .select("id,status,payload,created_at,updated_at,due_at")
          .eq("business_id",businessId).eq("owner_user_id",ownerId).eq("kind","maintenance_issue")
          .order("updated_at",{ascending:false}).limit(20);
        if(cases.error||!cases.data)
          return {source:"maintenance_cases",period:null,agentId:"leo",
            missing:["maintenance_source_unavailable"],cases:[]};
        const ids=cases.data.map(item=>item.id);
        const events=ids.length?await db.from("maintenance_case_events")
          .select("task_id,kind,source_kind,working_confirmed,occurred_at")
          .eq("business_id",businessId).in("task_id",ids)
          .order("occurred_at",{ascending:false}).limit(100):null;
        const missing=events?.error?["maintenance_event_history_unavailable"]:[];
        const byCase=new Map<string,Array<{kind:string;sourceKind:string;
          independentlyWorking:boolean;observedAt:string}>>();
        for(const event of events?.data??[]){
          const seen=byCase.get(event.task_id)??[];
          if(seen.length<5)seen.push({kind:event.kind,
            sourceKind:event.source_kind,
            independentlyWorking:event.kind==="operational_verification"&&
              event.source_kind==="owner_operational_check"&&event.working_confirmed===true,
            observedAt:event.occurred_at});
          byCase.set(event.task_id,seen);
        }
        return {source:"maintenance_cases",period:null,agentId:"leo",missing,
          cases:cases.data.map(item=>{
            const p=item.payload&&typeof item.payload==="object"&&!Array.isArray(item.payload)?
              item.payload as Record<string,unknown>:{};
            return {id:item.id,status:item.status,
              equipmentLabel:typeof p.equipmentLabel==="string"?p.equipmentLabel.slice(0,120):"unknown",
              reportedSymptom:typeof p.symptom==="string"?p.symptom.slice(0,600):null,
              reportIsEquipmentTelemetry:false,
              severity:typeof p.severity==="string"?p.severity:"unknown",
              maintenanceStage:typeof p.maintenanceStage==="string"?p.maintenanceStage:"unknown",
              repairVerified:p.repairVerified===true,
              externalSent:p.externalSent===true,
              reportedAt:typeof p.reportedAt==="string"?p.reportedAt:null,
              dueAt:item.due_at,createdAt:item.created_at,updatedAt:item.updated_at,
              recentEvidence:byCase.get(item.id)??[]};
          }),
          truncated:cases.data.length===20};
      }catch{
        return {source:"maintenance_cases",period:null,agentId:"leo",
          missing:["maintenance_source_unavailable"],cases:[]};
      }
    }
  }
} as const;

import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {ownerChoiceGuard,resolveEntity,choicePayload,normalizedName} from "../resolve";
import {getTeam} from "@/lib/actions/schedule";
import {mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
const uuid=z.uuid(),date=z.iso.date(),clock=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const shift=z.strictObject({employee_id:uuid,date,start:clock,end:clock,
  break_minutes:z.number().int().min(0).max(240)});
const person=z.strictObject({name:z.string().trim().min(1).max(80),
  role:z.string().trim().max(60).nullable(),wage_cents:z.number().int().min(1).max(10000000),
  phone:z.string().regex(/^\+[1-9]\d{1,14}$/).nullable()});
const rules=[
 "meal_break_enabled","meal_break_minutes","meal_break_after_minutes",
 "rest_break_enabled","rest_break_minutes","rest_break_every_minutes",
 "weekly_ot_enabled","weekly_ot_after_minutes","ot_multiplier_bp",
 "daily_ot_enabled","daily_ot_after_minutes","max_shift_enabled","max_shift_minutes",
 "min_shift_enabled","min_shift_minutes","min_rest_enabled","min_rest_minutes",
 "coverage_enabled","min_headcount","prep_minutes_before_open","prep_minutes_after_close"
] as const;
export const staffProposalInputs={
 propose_schedule:z.strictObject({week_start:date,shifts:z.array(shift).max(60)}),
 propose_shift_change:z.strictObject({shift_id:uuid.nullable(),shift,remove:z.boolean()}),
 propose_add_staff:person,
 propose_staff_change:z.strictObject({employee_id:uuid, ...person.shape,active:z.boolean()}),
 propose_availability_change:z.strictObject({instruction:z.string().trim().min(5).max(400)}),
 propose_rule_change:z.strictObject({rule:z.enum(rules),boolean_value:z.boolean().nullable(),
  number_value:z.number().int().min(0).max(50000).nullable()}),
 propose_send_schedule:z.strictObject({week_start:date}),
} as const;
export type StaffProposalName=keyof typeof staffProposalInputs;
export const isStaffProposalName=(value:string):value is StaffProposalName=>
 Object.hasOwn(staffProposalInputs,value);
const descriptions:Record<StaffProposalName,string>={
 propose_schedule:"Prepare an owner approval card to replace DRAFT shifts in a specific week. Include staff UUIDs, dates, local start/end and breaks. Never claim saved.",
 propose_shift_change:"Prepare a card to add, edit or remove a dated staff shift. Use an existing shift_id for edits; null for creates. No write before approval.",
 propose_add_staff:"Prepare an owner approval card to add a staff member with hourly wage in cents; never directly add.",
 propose_staff_change:"Prepare a card to change an existing staff member's name, role, hourly wage, phone or active status; provide the complete desired profile.",
 propose_availability_change:"Use when owner requests recurring availability or a day off in plain language, e.g. 'Maria can only work Mon, Wed, Fri mornings' or 'Sam is off next Tuesday'. Review before save.",
 propose_rule_change:"Prepare a card to change one team rule. Provide exactly one of boolean_value or number_value based on the rule type.",
 propose_send_schedule:"Prepare an owner approval card for COPY-READY staff schedule messages. WhatsApp transport is not connected to this tool; never claim sent.",
};
export const staffProposalTools=Object.fromEntries(
 (Object.keys(staffProposalInputs) as StaffProposalName[]).map(name=>[name,{
  agentId:"olivia" as const,description:descriptions[name],schema:staffProposalInputs[name],
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=staffProposalInputs[name].parse(raw);
   // The ordinary agent always supplies resolveState. Keep legacy tests that
   // call this handler directly compatible without weakening the live guard.
   if(ctx.resolveState&&name!=="propose_add_staff"&&name!=="propose_rule_change"&&name!=="propose_send_schedule"){
     const team=await getTeam({weekStart:mondayOfLocalDate(ctx.asOf)});
     if(!team.ok)return {source:"staff_proposal",period:null,agentId:"olivia",
       draft:true,saved:false,missing:["staffIdentityUnavailable"]};
     const people=team.data.team;
     const ids:string[]=[];
     if("employee_id" in input&&typeof input.employee_id==="string")ids.push(input.employee_id);
     if("shift" in input&&input.shift&&typeof input.shift==="object"&&"employee_id" in input.shift&&
       typeof input.shift.employee_id==="string")ids.push(input.shift.employee_id);
     if("shifts" in input&&Array.isArray(input.shifts))for(const shift of input.shifts)
       if(shift&&typeof shift==="object"&&"employee_id" in shift&&typeof shift.employee_id==="string")ids.push(shift.employee_id);
     for(const id of new Set(ids)){
       const person=people.find(p=>p.id===id);
       if(!person)return {source:"staff_proposal",period:null,agentId:"olivia",missing:["notFound"],suggestions:people.slice(0,4).map(p=>({id:p.id,label:p.name,detail:p.role??"Team"}))};
       const matched=resolveEntity("staff",person.name,people,{
         nameOf:p=>p.name,idOf:p=>p.id,describe:p=>p.role??"Team"});
       if(matched.status==="ambiguous"&&!ctx.resolveState.chosenIds.has(id.toLowerCase())){
         const guard=ownerChoiceGuard(ctx.resolveState,id);
         if(guard)return {source:"staff_proposal",period:null,agentId:"olivia",...guard};
         if(!ctx.resolveState.ambiguous.some(group=>group.some(choice=>choice.id===id)))
           return {source:"staff_proposal",period:null,agentId:"olivia",
             missing:["ownerChoiceRequired"],needsOwnerChoice:true,candidates:matched.candidates};
       }
     }
     if(name==="propose_availability_change"&&"instruction" in input){
       const wording=normalizedName(input.instruction);
       const mentioned=people.filter(p=>normalizedName(p.name)&&wording.includes(normalizedName(p.name)));
       const groups=new Map<string,typeof people>();
       for(const p of mentioned){const key=normalizedName(p.name);groups.set(key,[...(groups.get(key)??[]),p]);}
       for(const [key,group] of groups)if(group.length>1){
         const matched=resolveEntity("staff",key,people,{
           nameOf:p=>p.name,idOf:p=>p.id,describe:p=>p.role??"Team"});
         if(matched.status==="ambiguous"){
           // PR B's scoped availability parser accepts only an exact person
           // name (not a UUID). Choosing one of two identically named employees
           // still cannot produce a safe write until that API accepts an ID.
           if(group.some(person=>ctx.resolveState?.chosenIds.has(person.id.toLowerCase())))
             return {source:"staff_proposal",period:null,agentId:"olivia",
               missing:["availabilityBackendRequiresUniqueStaffName"]};
           return {...choicePayload(matched,"staff_proposal",null),agentId:"olivia",
             missing:["ownerChoiceRequired"]};
         }
       }
     }
   }
   if(!ctx.proposals?.proposeStaff)return {source:"staff_proposal",period:null,agentId:"olivia",
     draft:true,saved:false,missing:["proposalsUnavailable"]};
   const p=await ctx.proposals.proposeStaff({name,input});
   return {source:"staff_proposal",period:null,agentId:"olivia",draft:true,saved:false,
     missing:[],...p};
  },
 }])) as {[K in StaffProposalName]:{
  agentId:"olivia";description:string;schema:(typeof staffProposalInputs)[K];
  execute:(raw:unknown,ctx:AgentToolContext)=>Promise<AgentToolResult>
 }};

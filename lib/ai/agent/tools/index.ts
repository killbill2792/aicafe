import { presentationTools,presentResponse } from "./presentation";
import { z } from "zod";
import {askOwnerTools} from "./askOwner";
import {gmailTools} from "./gmail";
import {maintenanceTools} from "./maintenance";
import {staffQuestionTools} from "./staffQuestion";

import { staffTools } from "./staff";
import {scheduleReadTools} from "./scheduleReads";
import { moneyTools } from "./money";
import {goalTools,type GoalPort} from "./goals";
import {draftScheduleTools} from "./draftSchedule";
import {proposalTools} from "./proposals";
import {purchasesTools,purchaseToolInput} from "./purchases";
import {supplierPurchasingTools} from "./supplierPurchasing";
import type {SupplierPurchaseInput,SupplierPurchaseProposalInput} from "@/lib/ai/supervisor/loop/purchaseOrders.server";
import type {PurchasePlan} from "@/lib/purchasing/planOrder";
import type {SupplierOrderStatus} from "@/lib/data/supplierPurchasing.server";
import {priceExperimentTools} from "./priceExperiment";
import {staffProposalTools} from "./staffProposals";
import {memoryTools,type CafeMemoryPort} from "./memory";
import {eventsTools} from "./events";
import {savedEventsTools} from "./getEvents";
import {eventPlanTools,type EventPlanPort} from "./eventPlan";
import {webSearchTools} from "./webSearch";
import {commitmentTools} from "./commitments";
import {routineTools} from "./routines";
import type {RoutineRecord,RoutineSchedule} from "@/lib/ai/supervisor/routines/contracts";
import {ToolError} from "../toolErrors";
import {requestedPeriod as calcRequestedPeriod} from "@/lib/calc/periods";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { CafeStatePeriod } from "@/lib/operating/types";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type AgentLocale = "en" | "es" | "ar";
export type AgentToolResult = {
  source: string; period: CafeStatePeriod | null; missing: string[]; agentId?: "alex"|"olivia"|"maya"|"leo";
  [field: string]: unknown;
};
export type AgentToolContext = {
  /** Ephemeral per-turn schedule approval; prevents a second card if the model retries via propose_schedule. */
  scheduleProposalCreated?:{proposalId:string;revision:number;capabilityId:string};
  /** Same-turn verified draft roster identity; never attach changed shifts to a prior approval. */
  scheduleProposalKey?:string;
  tools: Partial<BusinessScopedCafeTools> & Pick<BusinessScopedCafeTools,"getProfitability"|"getSalesTrend"|"getMenuCatalog">;
  timezone:string;
  /** Authenticated ISO 4217 currency; absent only in legacy test contexts. */
  currency?:string|null;
  /** True for authenticated SQL research turns; guards owner-number questions. */
  sqlResearch?:boolean;
  /** Owner-verified staff communication evidence for off-turn investigations,
   * not a worker chat or model-supplied employee selector. */
  staffMessages?:{read:()=>ReturnType<
    typeof import("@/lib/staffCommunication/channel.server").readOwnerStaffMessages>;};
  /** Only supplied for an SQL-claimed scheduled investigation; never owner/model input. */
  investigation?:{
    read:()=>Promise<AgentToolResult>;
    /** Exact SQL-claimed café/owner, never a browser-session or model scope. */
    weekSchedule:(weekStart:string)=>ReturnType<
      typeof import("@/lib/data/staffSchedule.server").getWeekSchedule>;
  };
  /** Prior owner utterances for verifying explicit pricing percentages. */
  ownerMessages?:readonly string[];
  ownerText?:string;
  /** True only for an authenticated turn that admitted external evidence. */
  externalEvidencePresent?:()=>boolean;
  turnResults?:()=>ReadonlyArray<{name:string;result:AgentToolResult}>;
  /** Internal same-turn read/simulation arguments for verified presentation; no extra reads or scope. */
  presentationResults?:()=>ReadonlyArray<{name:string;arguments:string;result:AgentToolResult;ref?:string}>;
  /** Selected same-thread attachments already authenticated, read and rechecked by the existing runner. */
  presentationAttachments?:readonly string[];
  /** Ephemeral sanitized simulator basis. Never sent to the model/checkpoint. */
  presentationScenarioBasis?:WeakMap<object,import("@/lib/ai/conversations/scenarioPresentation").ScenarioEditorSeed>;
  resolveState?:import("../resolve").ResolveState;
  asOf: string; locale: AgentLocale;
  threadId?:string;ownerMessageId?:string;
  /** Bound by a verified owner turn, not model arguments or browser cookies. */
  commitments?:{
    create(input:{title:string;dueDate:string;dueTime:string|null;origin:"owner_chat"|"supervisor_followup"}):Promise<import("@/lib/operating/commitments.server").CommitmentView>;
    list():Promise<import("@/lib/operating/commitments.server").CommitmentView[]>;
    close(id:string):Promise<boolean>;
  };
  /** A verified thread/owner port; model input contains no café or user IDs. */
  routines?:{
    create(schedule:RoutineSchedule,goalSourceMessageId:string|null):Promise<RoutineRecord>;
    /** Validates a new routine and returns it unsaved; the owner's Save tap on the card creates it. */
    draft?(schedule:RoutineSchedule,goalSourceMessageId:string|null):{ownerMessageId:string;goalSourceMessageId:string};
    list():Promise<RoutineRecord[]>;
    /** On-demand paged verified owner-message previews; not authority to edit them. */
    goalSources(offset:number):Promise<{sources:Array<{id:string;text:string}>;nextOffset:number|null}>;
    change(input:{id:string;revision:number;status?:RoutineRecord["status"];
      schedule?:RoutineSchedule;objectiveEdit?:boolean}):Promise<RoutineRecord>;
  };
  gmail?:{labels():Promise<Record<string,unknown>>;
    search(query:string,limit:number):Promise<Record<string,unknown>>;
    read(messageId:string):Promise<Record<string,unknown>>;
    thread(threadId:string):Promise<Record<string,unknown>>;
    attachment(messageId:string,attachmentId:string):Promise<Record<string,unknown>>;
    propose(input:import("@/lib/ai/supervisor/loop/gmail.server").GmailProposalInput):Promise<{proposalId:string;revision:number;account:string}>};
  maintenance?:ReturnType<typeof import("@/lib/ai/supervisor/loop/maintenance.server").maintenanceContext>;
  /** Verified owner/claimed investigation port; proposals are inert until an owner click. */
  staffQuestionPropose?:(input:import("@/lib/ai/supervisor/loop/staffQuestion.server").StaffQuestionInput)=>
   Promise<{proposalId:string;revision:number}>;
  staffQuestionAnswer?:(proposalId:string,revision:number)=>Promise<{proposalId:string;ownerMessageId:string;employeeContacted:false}>;
  /** Owner-scoped purchasing capability in the ONE Supervisor. No model-supplied café IDs or approvals. */
  /** Owner/cafe scoped receiving evidence; no mutation or payment authority. */
  invoicePropose?:(input:import("@/lib/ai/supervisor/loop/supplierReceiving.server").InvoiceToolInput)=>Promise<{proposalId:string;revision:number}>;
  receivingPropose?:(input:import("@/lib/ai/supervisor/loop/supplierReceiving.server").ReceivingInput)=>Promise<{proposalId:string;revision:number}>;
  receivingFollowup?:(purchaseOrderId:string)=>Promise<{proposalId:string;revision:number;purchaseOrderId:string;recipient:string}>;
  financialSettlementPropose?:(input:import("@/lib/ai/supervisor/loop/supplierReceiving.server").FinancialSettlementInput)=>Promise<{proposalId:string;revision:number}>;
  financialBillPropose?:(input:import("@/lib/ai/supervisor/loop/supplierReceiving.server").FinancialBillInput)=>Promise<{proposalId:string;revision:number}>;
  purchasing?:{
    list():Promise<{orders:SupplierOrderStatus[];truncated:boolean;
      drafts:Array<{id:string;revision:number;supplierName:string;itemNames:string[];
        subtotalCents:number;currency:string}>;draftsTruncated:boolean;
      unresolvedApprovals:Array<{id:string;revision:number;supplierName:string;
        itemNames:string[];subtotalCents:number;currency:string;
        status:"approved"|"executing";attemptState:"executing"|"verified"|"uncertain"|"stale"|null;
        recovery:"owner_retry_or_cancel"|"receipt_only"}>;
      unresolvedApprovalsTruncated:boolean;
      vendorCommunications?:Array<{purchaseOrderId:string;state:string;channel:string|null;
        recipient:string|null;contactVerified:boolean;ownerReportedOutcome:string|null;
        providerVerified:boolean;ownerQuestion:string|null}>;
      gmailConnection?:{status:string;connected:boolean;canSend:boolean;canRead:boolean}}>;
    inspect(input:SupplierPurchaseInput):Promise<PurchasePlan>;
    /** Verified, latest-owner-message source report. Never an external Gmail receipt. */
    recordOwnerOutcome?(input:{
      purchaseOrderId:string;channel:"gmail"|"phone"|"portal"|"in_person"|"other";
      outcome:"unknown"|"not_contacted"|"supplier_contacted"|"supplier_acknowledged"|"supplier_accepted"|"supplier_declined";
      note:string
    }):Promise<{reportId:string;reportedAt:string;alreadyRecorded:boolean;
      source:"owner_reported";providerVerified:false;outcome:string}>;
    proposeVendorSend?(input:{purchaseOrderId:string}):Promise<{
      proposalId:string;revision:number;purchaseOrderId:string;
      supplierName:string;recipient:string;account:string;note:string
    }>;
    propose(input:SupplierPurchaseProposalInput):Promise<{proposalId:string;revision:number;
      supplierName:string;currency:string;subtotalCents:number}>;
  };
  /** CHAT_MEMORY only: drafts a café fact for owner approval (RLS, owner-scoped). */
  memory?: CafeMemoryPort;
  /** Goals in the Supervisor loop, bound to the authenticated owner. */
  goals?:GoalPort;
  /** Existing event-readiness proposal loop, owner scoped (or verified system cron). */
  eventPlans?:EventPlanPort;
  /** The session café's saved location (profile, else the owner's typed address). Never from model args. */
  cafeLocation?:()=>Promise<import("@/lib/data/cafeLocation.server").CafeLocation|null>;
  /** Read-only web search for public events near a location. */
  searchNearbyEvents?:import("@/lib/events/nearbyEvents").NearbyEventsSearch;
  /** Authenticated, saved-only timeline; never a web search. */
  savedEvents?:(from:string,to:string,options?:{cityEventId?:string;cafeEventId?:string})=>Promise<import("@/lib/data/cafeEvents.server").SavedEventTimeline>;
  /** General outside-world lookup; server checks current café AI access before each paid call. */
  webSearch?:(query:string,budget?:import("../webSearch.server").WebSearchBudget)=>Promise<import("../webSearch.server").WebSearchResult>;
  /** Same canonical café readers used by Staff and saved owner questions. */
  readWeekSchedule?:(weekStart:string)=>ReturnType<typeof import("@/lib/actions/schedule").getWeekSchedule>;
  oliviaPreview?:{
    week:typeof import("@/lib/actions/oliviaPlanning").previewOliviaWeek;
    absence:typeof import("@/lib/actions/oliviaPlanning").previewOliviaAbsenceWhatIf;
    ownerSavings:typeof import("@/lib/actions/oliviaPlanning").previewOliviaOwnerSavings;
  };
  ownerFacts?:readonly import("@/lib/ownerFacts/inject").SavedFact[];
  proposals?: {proposePriceChange(input:{productId:string;newPriceCents:number}):Promise<{proposalId:string;revision:number;productName:string;oldPriceCents:number;newPriceCents:number}>;
    proposePriceExperiment?(input:{productId:string;newPriceCents:number|null;increaseCents:number|null;days:number}):Promise<{proposalId:string;revision:number;productName:string;oldPriceCents:number;newPriceCents:number}>;
    proposeStaff?(input:{name:import("./staffProposals").StaffProposalName;input:unknown}):Promise<{proposalId:string;revision:number;capabilityId:string}>;
    proposePurchases?(input:z.infer<typeof purchaseToolInput>):Promise<Array<{proposalId?:string;revision?:number;name:string;saved?:boolean;error?:string}>>;};
};
// The model's café data reads are exclusively describe_database/run_sql.
export const schemas = {
  ...presentationTools, ...askOwnerTools,
  get_schedule:staffTools.get_schedule,
  get_week_schedule:scheduleReadTools.get_week_schedule,
  get_staff_messages:scheduleReadTools.get_staff_messages,
  propose_financial_settlement:moneyTools.propose_financial_settlement,
  propose_financial_bill:moneyTools.propose_financial_bill,
  draft_week_schedule:draftScheduleTools.draft_week_schedule,
  ...proposalTools,...priceExperimentTools,
  propose_goal:goalTools.propose_goal,record_checkin:goalTools.record_checkin,
  ...staffProposalTools,...purchasesTools,
  propose_purchase_receiving:supplierPurchasingTools.propose_purchase_receiving,
  propose_supplier_discrepancy_followup:supplierPurchasingTools.propose_supplier_discrepancy_followup,
  propose_invoice_reconciliation:supplierPurchasingTools.propose_invoice_reconciliation,
  propose_supplier_purchase_order:supplierPurchasingTools.propose_supplier_purchase_order,
  record_supplier_order_outcome:supplierPurchasingTools.record_supplier_order_outcome,
  propose_supplier_vendor_email:supplierPurchasingTools.propose_supplier_vendor_email,
  ...eventsTools,...savedEventsTools,...eventPlanTools,...webSearchTools,...commitmentTools,...routineTools,
  ...gmailTools,...maintenanceTools,...staffQuestionTools,
} as const;
export type AgentToolName = keyof typeof schemas;
/** Input fields backed by the shared entity/period resolver. A new tool whose
 * strict schema accepts a target must declare the corresponding field here;
 * creation inputs have explicit exemptions below. */
export const resolverCoverage:Partial<Record<AgentToolName,readonly string[]>>={

  propose_price_change:["product_id"],propose_price_experiment:["product_id"],propose_staff_change:["employee_id"],
  propose_schedule:["shifts.employee_id"],propose_shift_change:["shift.employee_id"],

  propose_availability_change:["instruction"]
};
export const resolverExemptions:Partial<Record<AgentToolName,readonly string[]>>={
  // These fields describe NEW values, not names or IDs of existing records.
  propose_add_staff:["name"],propose_staff_change:["name"],

  propose_supplier_purchase_order:["items.itemName","preferredSupplier"],
  // A public web search phrase is not a café catalog identifier.
  web_search:["query"],
  // Free-form Gmail search is owner text, not an internal catalogue identity.
  search_gmail:["query"],search_maintenance_vendor:["query"],
  // Exact case-linked employee IDs are revalidated by the scoped approval handler.
  propose_maintenance_staff_assignment:["employeeId"],
  propose_staff_question:["employeeId"],
  propose_event_plan:["summary","actions","expectedBusyHours"],
  manage_commitment:["title","due_date","due_time","origin","commitment_id"],
  manage_routine:["title","routine_id"]
};
export function agentForTool(name:string):"alex"|"olivia"|"maya"|"leo"{return name in staffTools||name in scheduleReadTools||name in staffProposalTools||name in staffQuestionTools||name==="draft_week_schedule"?"olivia":name in moneyTools||name in goalTools||name in commitmentTools||name in routineTools||name in maintenanceTools?"leo":name in purchasesTools||name in supplierPurchasingTools?"maya":"alex";}
/** OpenAI strict mode needs every property listed in `required` at every nesting level;
 * one gap rejects the whole request (HTTP 400), so the chat fails on every question.
 * Optional fields must therefore also be nullable in Zod so the model can send null. */
// Omit only generated regexes duplicating an existing standard format on the
// provider wire. Runtime Zod schemas still enforce every original constraint.
const redundantFormatPatterns=new Map<string,unknown>();
for(const schema of [z.iso.date(),z.iso.datetime(),z.uuid()]){
  const generated=z.toJSONSchema(schema,{target:"draft-07"}) as Record<string,unknown>;
  if(typeof generated.format==="string"&&typeof generated.pattern==="string")
    redundantFormatPatterns.set(generated.format,generated.pattern);
}
function requireEveryProperty(node:unknown):unknown{
  if(Array.isArray(node))return node.map(requireEveryProperty);
  if(!node||typeof node!=="object")return node;
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(node))out[key]=requireEveryProperty(value);
  if(out.properties&&typeof out.properties==="object"&&!Array.isArray(out.properties))
    out.required=Object.keys(out.properties);
  if(typeof out.format==="string"&&typeof out.pattern==="string"&&
      redundantFormatPatterns.get(out.format)===out.pattern)delete out.pattern;
  // JSON Schema's nullable primitive type array is equivalent to the
  // two-branch union. Preserve every constraint and enum member. Avoid
  // rewriting objects, arrays, references or complex combinators.
  // This keeps the complete registry in the bounded broker request.
  if(Object.keys(out).length===1&&Array.isArray(out.anyOf)&&out.anyOf.length===2){
    const alternatives=out.anyOf as Record<string,unknown>[];
    const nil=alternatives.find(x=>x&&Object.keys(x).length===1&&x.type==="null");
    const value=alternatives.find(x=>x!==nil);
    const allowed:Record<string,readonly string[]>={
      string:["type","format","pattern","minLength","maxLength","description","enum"],
      number:["type","minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","description","enum"],
      integer:["type","minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","description","enum"],
      boolean:["type","description","enum"],
    };
    if(nil&&value&&typeof value.type==="string"&&Object.hasOwn(allowed,value.type)&&
       Object.keys(value).every(key=>allowed[value.type as string].includes(key))&&
       (!Object.hasOwn(value,"enum")||Array.isArray(value.enum))){
      const compact={...value,type:[value.type,"null"]};
      return Array.isArray(value.enum)?{...compact,enum:[...value.enum,null]}:compact;
    }
  }
  return out;
}
const baseToolDefinitions = (Object.keys(schemas) as AgentToolName[]).map(name => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schemas[name].schema as z.ZodType, { target: "draft-07" });
  void _schema;
  // Empty strict Zod objects omit required in JSON Schema; OpenAI needs it explicitly.
  const properties=parameters.properties;
  const required=properties && typeof properties==="object" ? Object.keys(properties) : [];
  return { type: "function" as const, name,
    description: schemas[name].description,
    strict: true as const, parameters:{...requireEveryProperty(parameters) as typeof parameters,required} };
});
/** Function names stay plain strings: memory and capability gating add or filter by name. */
// Routine management is a verified-owner-only additional function, rather
// than a global public tool. Keep the existing baseline tool contract stable.
export const agentToolDefinitions:Array<Omit<(typeof baseToolDefinitions)[number],"name">&{name:string}>=
  baseToolDefinitions.filter(tool=>tool.name!=="manage_routine"&&!["search_gmail","list_gmail_labels","read_gmail","read_gmail_thread","read_gmail_attachment","propose_gmail_action"].includes(tool.name));
/** Offered only for a verified connected owner. Default cafés keep their existing tools. */
/** Offered only when a server-claimed autonomous run explicitly requests it. */
export const gmailToolDefinitions=baseToolDefinitions.filter(tool=>["search_gmail","list_gmail_labels","read_gmail","read_gmail_thread","read_gmail_attachment","propose_gmail_action"].includes(tool.name));
export const agentLabelsPrompt = "Field labels by language (use matching language, not translated numeric units): " +
  JSON.stringify({ en: en.AgentFields, es: es.AgentFields, ar: ar.AgentFields });

export const requestedPeriod=calcRequestedPeriod;

/**
 * This is a conservative deny boundary for mixed-trust turns, not a second
 * authorization system. Existing gateway approval/receipt rules remain mandatory.
 * Internal direct mutations must have a fresh owner-only turn; a supplier letter
 * cannot silently reschedule the owner's routines or create/close commitments.
 */
export function blocksExternalControlMutation(name:string,raw:unknown,ownerText:string):boolean{
 const action=raw&&typeof raw==="object"&&"action" in raw?raw.action:null;
 if((name==="manage_routine"||name==="manage_commitment")&&action!=="list")return true;
 if(name==="record_checkin"||name==="remember_cafe_fact")return true;
 // A clear owner restriction is a deny, never a grant of authority.
 const readOnly=/\b(?:read|review|summarize|inspect|compare|explain)\s+only\b|\b(?:do not|don't|never|without)\s+(?:send|approve|change|create|order|record|update|save|modify|draft|make changes)\b/iu.test(ownerText);
 const simpleRead=/^\s*(?:please\s+)?(?:read|review|summarize|inspect|compare|explain|show|check)\b/iu.test(ownerText)&&
   !/\b(?:and|then)\s+(?:draft|prepare|propose|send|create|record|update|change|order)\b/iu.test(ownerText);
 return (readOnly||simpleRead)&&(name.startsWith("propose_")||name==="draft_week_schedule"||
   name==="record_supplier_order_outcome");
}
export async function executeAgentTool(name: string, raw: unknown, ctx: AgentToolContext): Promise<AgentToolResult> {
  if(ctx.externalEvidencePresent?.()&&blocksExternalControlMutation(name,raw,ctx.ownerText??""))
    return {source:name,period:null,missing:["owner_action_confirmation_required"]};
  // Flag-gated extra tool: only offered to the model when CHAT_MEMORY is on.
  if(name==="remember_cafe_fact")return memoryTools.remember_cafe_fact.execute(raw,ctx);
  if (!Object.hasOwn(schemas, name)) throw new ToolError("not_supported");
  if(name==="present_response")return presentResponse(raw,ctx);
  if(name==="ask_owner")return askOwnerTools.ask_owner.execute(raw,ctx);
  if(name==="search_gmail")return gmailTools.search_gmail.execute(raw,ctx);
  if(name==="list_gmail_labels")return gmailTools.list_gmail_labels.execute(raw,ctx);
  if(name==="read_gmail")return gmailTools.read_gmail.execute(raw,ctx);
  if(name==="read_gmail_thread")return gmailTools.read_gmail_thread.execute(raw,ctx);
  if(name==="read_gmail_attachment")return gmailTools.read_gmail_attachment.execute(raw,ctx);
  if(name==="propose_gmail_action")return gmailTools.propose_gmail_action.execute(raw,ctx);
  if(name==="propose_maintenance_staff_assignment")return maintenanceTools.propose_maintenance_staff_assignment.execute(raw,ctx);
  if(name==="propose_staff_question")return staffQuestionTools.propose_staff_question.execute(raw,ctx);
  if(name==="record_staff_question_owner_answer")return staffQuestionTools.record_staff_question_owner_answer.execute(raw,ctx);
  if(name==="record_maintenance_repair_claim")return maintenanceTools.record_maintenance_repair_claim.execute(raw,ctx);
  if(name==="search_maintenance_vendor")return maintenanceTools.search_maintenance_vendor.execute(raw,ctx);
  if(name==="propose_maintenance_vendor_request")return maintenanceTools.propose_maintenance_vendor_request.execute(raw,ctx);
  if(name==="draft_week_schedule")return draftScheduleTools.draft_week_schedule.execute(raw,ctx);
  if(name==="propose_price_change")return proposalTools.propose_price_change.execute(raw,ctx);
   if(name==="propose_purchases")return purchasesTools.propose_purchases.execute(raw,ctx);
  if(name==="propose_purchase_receiving")return supplierPurchasingTools.propose_purchase_receiving.execute(raw,ctx);
  if(name==="propose_supplier_discrepancy_followup")return supplierPurchasingTools.propose_supplier_discrepancy_followup.execute(raw,ctx);
  if(name==="propose_invoice_reconciliation")return supplierPurchasingTools.propose_invoice_reconciliation.execute(raw,ctx);
  if(name==="propose_supplier_purchase_order")return supplierPurchasingTools.propose_supplier_purchase_order.execute(raw,ctx);
  if(name==="record_supplier_order_outcome")return supplierPurchasingTools.record_supplier_order_outcome.execute(raw,ctx);
  if(name==="propose_supplier_vendor_email")return supplierPurchasingTools.propose_supplier_vendor_email.execute(raw,ctx);
  if(name==="propose_price_experiment")return priceExperimentTools.propose_price_experiment.execute(raw,ctx);
  if(name==="propose_goal")return goalTools.propose_goal.execute(raw,ctx);
  if(name==="propose_event_plan")return eventPlanTools.propose_event_plan.execute(raw,ctx);
  if(name==="record_checkin")return goalTools.record_checkin.execute(raw,ctx);
  if(Object.hasOwn(staffProposalTools,name))return staffProposalTools[name as keyof typeof staffProposalTools].execute(raw,ctx);
  if(name==="manage_commitment")return commitmentTools.manage_commitment.execute(raw,ctx);
  if(name==="manage_routine")return routineTools.manage_routine.execute(raw,ctx);
  if(name==="get_schedule")return staffTools.get_schedule.execute(raw,ctx);
  if(name==="get_staff_messages")return scheduleReadTools.get_staff_messages.execute(raw,ctx);
  if(name==="get_week_schedule")return scheduleReadTools.get_week_schedule.execute(raw,ctx);
  if(name==="propose_financial_settlement")return moneyTools.propose_financial_settlement.execute(raw,ctx);
  if(name==="propose_financial_bill")return moneyTools.propose_financial_bill.execute(raw,ctx);
  if(name==="get_nearby_events")return eventsTools.get_nearby_events.execute(raw,ctx);
  if(name==="get_events")return savedEventsTools.get_events.execute(raw,ctx);
  if(name==="web_search")return webSearchTools.web_search.execute(raw,ctx);
  throw new ToolError("not_supported");
}

/** Durable recovery safety classification. Membership is based on reviewed
 * handlers, never a tool-name prefix or owner/model wording. Unknown or
 * mixed read/write capabilities default to an effect boundary. */
const repeatSafeOwnerTools:ReadonlySet<string>=new Set([
 "get_schedule","get_week_schedule","get_staff_messages","get_events","get_nearby_events",
 "search_gmail","list_gmail_labels","read_gmail","read_gmail_thread","read_gmail_attachment",
 "web_search","search_maintenance_vendor","ask_owner","describe_database","run_sql","calculate","search_web",
]);
export function isRepeatSafeOwnerTool(name:string,input:unknown):boolean{
 if(name==="present_response"||repeatSafeOwnerTools.has(name))return true;
 if(name==="draft_week_schedule"){
   const parsed=draftScheduleTools.draft_week_schedule.schema.safeParse(input);
   return parsed.success&&["owner_savings","compare_only","cash_preview","owner_time_preview"].includes(parsed.data.purpose);
 }
 if(name==="manage_routine"||name==="manage_commitment"){
   const schema=name==="manage_routine"?routineTools.manage_routine.schema:commitmentTools.manage_commitment.schema;
   const parsed=schema.safeParse(input);
   return parsed.success&&parsed.data.action==="list";
 }
 return false;
}

/** Reviewed mutation ports for tools whose handlers cannot write anywhere else.
 * The observer is per invocation; it cannot be supplied by the model.
 * Unknown/new writers never get no-effect proof. A timeout closes the port
 * without pretending the already-dispatched work is cancelled. */
const durableEffectPorts:Readonly<Record<string,readonly string[]>>={
  propose_price_change:["proposals.proposePriceChange"],
  propose_price_experiment:["proposals.proposePriceExperiment"],
  propose_add_staff:["proposals.proposeStaff"],propose_staff_change:["proposals.proposeStaff"],
  propose_schedule:["proposals.proposeStaff"],propose_shift_change:["proposals.proposeStaff"],
  propose_availability_change:["proposals.proposeStaff"],propose_rule_change:["proposals.proposeStaff"],
  propose_send_schedule:["proposals.proposeStaff"],draft_week_schedule:["proposals.proposeStaff"],
  propose_purchases:["proposals.proposePurchases"],
  propose_supplier_purchase_order:["purchasing.propose"],
  propose_supplier_vendor_email:["purchasing.proposeVendorSend"],
  record_supplier_order_outcome:["purchasing.recordOwnerOutcome"],
  propose_purchase_receiving:["receivingPropose"],propose_invoice_reconciliation:["invoicePropose"],
  propose_supplier_discrepancy_followup:["receivingFollowup"],
  propose_financial_settlement:["financialSettlementPropose"],propose_financial_bill:["financialBillPropose"],
  propose_goal:["goals.propose"],record_checkin:["goals.recordCheckin"],
  propose_event_plan:["eventPlans.propose"],remember_cafe_fact:["memory.proposeFact"],
  manage_commitment:["commitments.create","commitments.close"],
  manage_routine:["routines.create","routines.change"],propose_gmail_action:["gmail.propose"],
  propose_maintenance_staff_assignment:["maintenance.proposeStaff"],
  // The only model-invocable staff-question mutation ports. Neither contacts a worker.
  propose_staff_question:["staffQuestionPropose"],
  record_staff_question_owner_answer:["staffQuestionAnswer"],
  propose_maintenance_vendor_request:["maintenance.propose"],
  record_maintenance_repair_claim:["maintenance.recordRepairClaim"],
};
export function observeDurableToolEffect(name:string,context:AgentToolContext,beforeDispatch:()=>Promise<void>){
  const paths=Object.hasOwn(durableEffectPorts,name)?durableEffectPorts[name]:undefined;
  let dispatched=false,closed=false,settled=false;
  const wrap=(target:object,fn:(...args:unknown[])=>unknown)=>async(...args:unknown[])=>{
    if(closed)throw new Error("tool_deadline_exceeded");
    await beforeDispatch();
    if(closed)throw new Error("tool_deadline_exceeded");
    dispatched=true;
    return Reflect.apply(fn,target,args);
  };
  const observed=paths?new Proxy(context,{
    get(target,key,receiver){
      const value=Reflect.get(target,key,receiver);
      if(typeof key!=="string")return value;
      if(paths.includes(key)&&typeof value==="function")return wrap(target,value);
      const nested=paths.filter(p=>p.startsWith(key+".")).map(p=>p.slice(key.length+1));
      if(!nested.length||!value||typeof value!=="object")return value;
      return new Proxy(value,{
        get(port,method,portReceiver){
          const fn=Reflect.get(port,method,portReceiver);
          return typeof method==="string"&&nested.includes(method)&&typeof fn==="function"?wrap(port,fn):fn;
        },
      });
    },
  }):context;
  return {context:observed,settle:()=>{if(!closed)settled=true;},close:()=>{closed=true;},
    noEffect:()=>Boolean(paths&&settled&&!dispatched)};
}

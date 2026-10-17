import "server-only";
import {z} from "zod";
import {unit as expressionUnit} from "@/lib/calc/scenarioExpression";
import {analyzeDataset,datasetPlanSchema,type AuthorizedDataset,type DatasetField} from "@/lib/calc/datasetAnalysis";
import {schemaFingerprint,type ReadRegistration} from "../p2/registry";

/** Field units belong to data contracts, never question-specific formulas or
 * model guesses from a field name. All other authorized fields remain usable
 * for reasoning/filtering/grouping; unsupported numeric units fail closed. */
const units:Record<string,Record<string,z.infer<typeof expressionUnit>>>={
  "menu.catalog":{priceCents:"USD_cents"},
  "sales.item_units":{units:"item"},
  "sales.daily":{netSalesCents:"USD_cents",ordersCount:"scalar",drinksCount:"item"},
  "money.expense_entries":{amountCents:"USD_cents"},
  "money.recurring_bill_rows":{amountCents:"USD_cents"},
  "labor.daily_costs":{wagesCents:"USD_cents",staffTaxCents:"USD_cents",loadedStaffCostCents:"USD_cents"},
  "labor.employee_wages":{defaultHourlyWageCents:"USD_cents_per_hour"},
  "labor.attendance":{timecardCount:"scalar",onClockCount:"scalar"},
};
export type StoredDataset={sourceId:string;dataset:AuthorizedDataset;revision:string|null};
export function datasetFor(sourceId:string,value:unknown,quality:{missingInputs:string[];estimatedInputs:string[];staleInputs:string[]}):AuthorizedDataset|null{
  const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
  const rows=Array.isArray(value)?value:record(value)&&Array.isArray(value.items)?value.items:[value];
  if(rows.length>500||rows.some(r=>!record(r)))return null;
  const fields=new Map<string,DatasetField>();
  for(const row of rows as Record<string,unknown>[])for(const [key,v] of Object.entries(row)){
    if(!/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(key)||v!==null&&!["string","number","boolean"].includes(typeof v))continue;
    fields.set(key,{key,numeric:Boolean(units[sourceId]?.[key]),unit:units[sourceId]?.[key]??null,
      ...(sourceId==="labor.employee_wages"&&key==="defaultHourlyWageCents"?
        {known:(r:Readonly<Record<string,unknown>>)=>r.active===true&&r.wageKnown===true&&r.wagePeriod==="hour"&&
          typeof r.defaultHourlyWageCents==="number"&&r.defaultHourlyWageCents>0}:{})});
  }
  // An item listing is not stock, a recurring bill is planned rather than paid,
  // and uncovered sales rows cannot silently become observed zero revenue.
  const invalidSales=sourceId==="sales.daily"&&rows.some(r=>record(r)&&r.salesDataStatus!=="actual");
  if(invalidSales)return null;
  return {rows:rows as Record<string,unknown>[],fields:[...fields.values()],...quality};
}
export const DATASET_ID="p3.platform.dataset.analysis.v1";
const qualitySchema=z.strictObject({missingInputs:z.array(z.string().max(300)).max(200),
  estimatedInputs:z.array(z.string().max(300)).max(200),staleInputs:z.array(z.string().max(300)).max(200)});
const outputSchema=z.union([
  z.strictObject({status:z.literal("unavailable"),value:z.null(),reason:z.string().max(100)}),
  z.strictObject({status:z.literal("partial"),id:z.literal("platform.dataset.analysis"),
    value:z.strictObject({groups:z.array(z.strictObject({group:z.string().max(500).nullable(),value:z.number().int().safe()})).max(20),
      unit:expressionUnit,sourceReadId:z.string(),operation:z.string(),field:z.string().nullable()}),
    provenance:z.strictObject({sourceId:z.literal("platform.authorized_dataset"),canonicalReaderId:z.literal("platform.dataset.analysis"),
      sourceRevision:z.string().nullable(),asOf:z.string(),purpose:z.literal("dataset_analysis")}),quality:qualitySchema}),
]);
export function buildDatasetRegistration(store:ReadonlyMap<string,StoredDataset>,businessId:string):ReadRegistration{
  return {id:DATASET_ID,version:1,owner:"platform",mode:"read",availability:"shadow",currencyPolicy:"independent",
    purpose:"Pure count, sum, min, max and grouped analysis of any previously authorized dataset using its declared field/unit contract. Filter by actual schema fields. No new database reads. Record counts are never physical stock counts; recurring amounts retain their frequency and planned/estimated status.",
    sourceIds:["platform.authorized_dataset"],canonicalReaderIds:["platform.dataset.analysis"],allowedPurposes:["dataset_analysis"],
    inputSchema:datasetPlanSchema,outputSchema,schemaContract:{id:DATASET_ID+".v1",registrationId:DATASET_ID,version:1,
      inputSchemaFingerprint:schemaFingerprint(datasetPlanSchema),outputSchemaFingerprint:schemaFingerprint(outputSchema)},
    requiredRole:"owner",sensitivity:"financial",requiresApproval:false,effectPolicy:"deny",
    budgets:{maxOperations:1,timeoutMs:1000,maxInputBytes:4000,maxResultBytes:20000,maxRangeDays:365},
    async read(scope,raw){
      if(scope.businessId!==businessId)return {status:"unavailable",value:null,reason:"unauthorized"};
      const input=datasetPlanSchema.parse(raw),source=store.get(input.readId);
      if(!source)return {status:"unavailable",value:null,reason:"unknown_dataset"};
      if(scope.identity.currency!=="USD"&&input.field&&source.dataset.fields.find(f=>f.key===input.field)?.unit?.startsWith("USD_"))
        return {status:"unavailable",value:null,reason:"unsupported_currency"};
      if(source.sourceId==="money.recurring_bill_rows"&&input.operation!=="count"&&
        new Set(source.dataset.rows.map(r=>r.frequency)).size>1)
        return {status:"unavailable",value:null,reason:"incompatible_bill_frequencies"};
      const result=analyzeDataset(input,source.dataset);
      if(!result.ok)return {status:"unavailable",value:null,reason:result.reason};
      return {status:"partial",id:"platform.dataset.analysis",value:{groups:result.groups,unit:result.unit,
        sourceReadId:input.readId,operation:input.operation,field:input.field},
        provenance:{sourceId:"platform.authorized_dataset",canonicalReaderId:"platform.dataset.analysis",sourceRevision:source.revision,
          asOf:scope.identity.asOf,purpose:input.purpose},
        quality:{missingInputs:[...source.dataset.missingInputs,"dataset_analysis_is_source_scoped"],
          estimatedInputs:[...source.dataset.estimatedInputs],staleInputs:[...source.dataset.staleInputs]}};
    }};
}

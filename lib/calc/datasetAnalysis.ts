import {z} from "zod";
import {unit as expressionUnit} from "./scenarioExpression";
const scalar=z.union([z.string().max(500),z.number().finite(),z.boolean(),z.null()]);
export const datasetPlanSchema=z.strictObject({
  purpose:z.literal("dataset_analysis"),readId:z.string().regex(/^r\d+$/),
  operation:z.enum(["count","sum","min","max"]),field:z.string().min(1).max(120).nullable(),
  groupBy:z.string().min(1).max(120).nullable(),
  filters:z.array(z.strictObject({field:z.string().min(1).max(120),
    operator:z.enum(["eq","gte","lte"]),value:scalar})).max(6),
});
export type DatasetPlan=z.infer<typeof datasetPlanSchema>;
export type DatasetField={key:string;unit:z.infer<typeof expressionUnit>|null;numeric:boolean;
  known?:(row:Readonly<Record<string,unknown>>)=>boolean};
export type AuthorizedDataset={rows:ReadonlyArray<Record<string,unknown>>;fields:readonly DatasetField[];
  missingInputs:readonly string[];estimatedInputs:readonly string[];staleInputs:readonly string[]};
/** Pure, bounded record arithmetic over a server-created authorized field manifest.
 * No object-path evaluation, code/SQL, unknown-value coercion or financial formulas. */
export function analyzeDataset(plan:DatasetPlan,dataset:AuthorizedDataset):
  {ok:true;groups:Array<{group:string|null;value:number}>;unit:NonNullable<DatasetField["unit"]>}
  |{ok:false;reason:string}{
  const fields=new Map(dataset.fields.map(f=>[f.key,f]));
  const field=plan.field?fields.get(plan.field):null;
  if(dataset.rows.length>500||plan.operation!=="count"&&(!field?.numeric||!field.unit)||
    plan.groupBy&&!fields.has(plan.groupBy)||plan.filters.some(f=>!fields.has(f.field)))
    return {ok:false,reason:"invalid_dataset_field"};
  const rows=dataset.rows.filter(row=>plan.filters.every(f=>{
    const v=row[f.field];
    if(v===null||v===undefined)return f.operator==="eq"&&f.value===null;
    if(typeof v!==typeof f.value)return false;
    if(f.operator==="eq")return v===f.value;
    if(typeof v==="number"&&typeof f.value==="number")return f.operator==="gte"?v>=f.value:v<=f.value;
    if(typeof v==="string"&&typeof f.value==="string")return f.operator==="gte"?v>=f.value:v<=f.value;
    return false;
  }));
  const groups=new Map<string|null,bigint[]>();
  if(!plan.groupBy)groups.set(null,[]);
  for(const row of rows){
    if(plan.operation!=="count"&&field?.known?.(row)===false)return {ok:false,reason:"dataset_values_missing_or_fractional"};
    const raw=plan.operation==="count"?1:row[plan.field!];
    // Null/missing means unknown. Never turn it into a zero total.
    if(typeof raw!=="number"||!Number.isSafeInteger(raw))return {ok:false,reason:"dataset_values_missing_or_fractional"};
    const label=plan.groupBy?row[plan.groupBy]:null;
    if(label!==null&&typeof label!=="string"&&typeof label!=="number"&&typeof label!=="boolean")
      return {ok:false,reason:"dataset_group_missing"};
    const key=label===null?null:String(label);
    groups.set(key,[...(groups.get(key)??[]),BigInt(raw)]);
    if(groups.size>20)return {ok:false,reason:"dataset_group_limit"};
  }
  const output:Array<{group:string|null;value:number}>=[];
  for(const [group,values] of groups){
    if(!values.length&&plan.operation!=="count"&&plan.operation!=="sum")
      return {ok:false,reason:"empty_dataset"};
    const amount=plan.operation==="min"?values.reduce((a,b)=>a<b?a:b):
      plan.operation==="max"?values.reduce((a,b)=>a>b?a:b):values.reduce((a,b)=>a+b,BigInt(0));
    if(amount>BigInt(1_000_000_000_000)||amount<BigInt(-1_000_000_000_000))
      return {ok:false,reason:"dataset_value_limit"};
    output.push({group,value:Number(amount)});
  }
  return {ok:true,groups:output,unit:plan.operation==="count"?"scalar":field!.unit!};
}

import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readCanonicalView} from "@/lib/data/canonical/reads.server";
import {canonicalDictionary,canonicalViewNames,
 isCanonicalColumn,type CanonicalView} from "@/lib/data/canonical/dictionary";

export type DataQueryContext={db:SupabaseClient;businessId:string};
const DEFAULT_ROWS=50,MAX_ROWS=100;
const atom=z.union([z.string().max(256),z.number().finite(),z.boolean()]);
const filter=z.strictObject({column:z.string().max(100),
 op:z.enum(["=","!=","<","<=",">",">=","in","between","ilike"]),
 value:z.union([atom,z.array(atom).max(100)])});
const metric=z.strictObject({fn:z.enum(["sum","count","avg","min","max"]),
 column:z.string().max(100)});
export const dataQuerySchema=z.strictObject({
 view:z.enum(canonicalViewNames),
 columns:z.array(z.string().max(100)).max(20).nullable(),
 filters:z.array(filter).max(15).nullable(),
 group_by:z.array(z.string().max(100)).max(4).nullable(),
 metrics:z.array(metric).max(10).nullable(),
 date_from:z.iso.date(),date_to:z.iso.date(),
 order_by:z.strictObject({column:z.string().max(100),
   direction:z.enum(["asc","desc"])}).nullable(),
 // A tool result must stay compact (AGENTS.md: about 1.5k tokens). Ask for totals
 // with group_by/metrics instead of paging through raw rows.
 limit:z.number().int().min(1).max(MAX_ROWS).nullable()
});
const empty=(code:string)=>({source:"canonical_data",period:null,
 missing:[code],empty:true,error:code,rows:[],rowCount:0,truncated:false,sourceMix:{}});
function validColumns(view:CanonicalView,columns:string[]):boolean{
 return columns.every(col=>isCanonicalColumn(view,col));
}
export const dataQueryTools={
 describe_data:{
  agentId:"alex" as const,
  schema:z.strictObject({}),
  description:"List permitted canonical café views and plain-language column meanings; no SQL.",
  execute:async(_raw:unknown)=>{
   z.strictObject({}).parse(_raw);
   return {source:"canonical_dictionary",period:null,missing:[],
    views:canonicalViewNames.map(view=>({name:view,meaning:canonicalDictionary[view].meaning,
     columns:Object.entries(canonicalDictionary[view].columns).map(([name,metadata])=>({
      name,meaning:metadata.meaning,unit:metadata.unit,source:metadata.source
     }))}))};
  }
 },
 query_data:{
  agentId:"alex" as const,schema:dataQuerySchema,
  description:"Read and aggregate ONLY allowlisted canonical views through a café-scoped, RLS-invoker RPC. Supply dates and null for omitted filters/grouping. Returns at most 100 rows (50 by default): prefer group_by and metrics for totals.",
  execute:async(raw:unknown,ctx:DataQueryContext)=>{
   const parsed=dataQuerySchema.safeParse(raw);
   if(!parsed.success)return empty("invalid_query");
   const p=parsed.data;
   if(!z.uuid().safeParse(ctx.businessId).success||!ctx.db)return empty("invalid_scope");
   if(p.date_from>p.date_to)
    return empty("invalid_date_range");
   const all=[...(p.columns??[]),...(p.group_by??[]),
    ...(p.filters??[]).map(f=>f.column),...(p.metrics??[]).map(m=>m.column)];
   if(!validColumns(p.view,all))return empty("column_not_allowed");
   if((p.filters??[]).some(f=>(f.op==="between"&&(!Array.isArray(f.value)||f.value.length!==2))||
    (f.op==="in"&&(!Array.isArray(f.value)||f.value.length===0))||
    (!["between","in"].includes(f.op)&&Array.isArray(f.value))))
    return empty("invalid_filter");
   // Simple rows use the same bounded canonical reader available to owner screens.
   // Grouped sums/averages continue through the server-side invoker SQL RPC;
   // never sum a truncated or partial row slice in JavaScript.
   if(!(p.filters?.length)&&!(p.group_by?.length)&&!(p.metrics?.length)&&!p.order_by){
    try{
     const result=await readCanonicalView(ctx.db,ctx.businessId,p.view,
      {dateFrom:p.date_from,dateTo:p.date_to},p.limit??DEFAULT_ROWS);
     if(result.error)return empty(result.error);
     const rows=result.rows.map(row=>p.columns?.length?
      Object.fromEntries(p.columns.map(column=>[column,row[column]??null])):row);
     const mix:Record<string,number>={};
     for(const row of result.rows){
      const source=typeof row.source==="string"?row.source:"unknown";
      mix[source]=(mix[source]??0)+1;
     }
     const hasIncomplete=result.rows.some(row=>["open","estimated","needs_match"].includes(String(row.status)));
     return {source:"canonical_data",period:{from:p.date_from,to:p.date_to},
      missing:[...(rows.length===0?["empty"]:[]),
       ...(hasIncomplete?["incompleteEvidence"]:[]),
       ...(result.truncated?["result_truncated"]:[])],
      empty:rows.length===0,error:undefined as string|undefined,
      rows,rowCount:rows.length,truncated:result.truncated,sourceMix:mix};
    }catch{return empty("source_read_failed");}
   }
   // The database independently validates the view and columns. It executes as
   // the authenticated caller, not service_role or a definer.
   try{
    const {data,error}=await ctx.db.rpc("ai_query_view",{
     p_business_id:ctx.businessId,p_view:p.view,p_columns:p.columns,
     p_filters:p.filters??[],p_group_by:p.group_by??[],
     p_metrics:p.metrics??[],p_date_from:p.date_from,p_date_to:p.date_to,
     p_order_by:p.order_by,p_limit:p.limit??DEFAULT_ROWS
    });
    if(error)return empty("source_read_failed");
    const result=data as {rows?:unknown[];rowCount?:number;truncated?:boolean;
      sourceMix?:Record<string,number>;sourceCount?:number;hasIncomplete?:boolean}|null;
    const rows=Array.isArray(result?.rows)?result.rows:[];
    return {source:"canonical_data",period:{from:p.date_from,to:p.date_to},
     missing:[...(rows.length===0||result?.sourceCount===0?["empty"]:[]),
      ...(result?.hasIncomplete?["incompleteEvidence"]:[]),
      ...(result?.truncated?["result_truncated"]:[])],
     empty:rows.length===0||result?.sourceCount===0,error:undefined as string|undefined,rows,rowCount:rows.length,
     truncated:result?.truncated===true,sourceMix:result?.sourceMix??{}};
   }catch{return empty("source_read_failed");}
  }
 }
} as const;

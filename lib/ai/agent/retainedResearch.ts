import type {AgentToolResult} from "./tools";
import type {RestoredResearchRead} from "@/lib/ai/supervisor/runs/contracts";

/** Read the existing in-memory snapshot of this exact run. This is transport,
 * not a new observation, authorization, data query or calculator receipt. */
export function readRetainedResearch(reads:readonly RestoredResearchRead[],ref:string,path:string,offset:number,budget:number):AgentToolResult{
 const fail=(code:string):AgentToolResult=>({source:"retained_research_receipt",period:null,missing:[code],error:code});
 const read=reads.find(r=>r.ref===ref);
 if(!read||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(budget)||budget<=0)
  return fail("retained_receipt_unavailable");
 const parts=path.split(".");
 if(!["arguments","result"].includes(parts[0]))return fail("invalid_retained_path");
 let value:unknown={arguments:JSON.parse(read.arguments),result:read.result};
 for(const field of parts){
  if(value===null||typeof value!=="object"||!Object.hasOwn(value,field)||
     ["__proto__","constructor","prototype"].includes(field))return fail("invalid_retained_path");
  value=(value as Record<string,unknown>)[field];
 }
 const e=read.result.evidence;
 const base={source:"retained_research_receipt",period:read.result.period,missing:[],
  ref,original_tool:read.name,original_source:read.result.source,path,
  original_receipt_id:e&&typeof e==="object"?(e as Record<string,unknown>).receipt_id??null:null,
  original_missing:read.result.missing,original_truncated:read.result.truncated===true,
  observation:"original_run_snapshot_not_current_read"};
 const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),"utf8");
 if(!Array.isArray(value)){
  if(offset!==0)return fail("invalid_retained_offset");
  const result={...base,value,next_offset:null,truncated:false};
  return bytes(result)<=budget?result:{...fail("retained_value_exceeds_context"),
    ref,path,available_fields:value&&typeof value==="object"?Object.keys(value):[]};
 }
 if(offset>value.length)return fail("invalid_retained_offset");
 const rows:unknown[]=[];
 const envelope={...base,offset,total:value.length,value:rows,next_offset:offset,truncated:true};
 let size=bytes(envelope);
 for(let i=offset;i<value.length;i++){
  const n=bytes(value[i])+(rows.length?1:0);
  if(size+n+64>budget)break;
  rows.push(value[i]);size+=n;
 }
 if(offset<value.length&&!rows.length)return fail("retained_value_exceeds_context");
 const end=offset+rows.length;
 return {...envelope,next_offset:end<value.length?end:null,truncated:end<value.length};
}

/** Discover retained result references without exposing private data as
 * developer instructions. The page allowance follows provider capacity. */
export function retainedResearchCatalog(reads:readonly RestoredResearchRead[],offset:number,limit:number|null,budget:number):AgentToolResult{
 const fail=(code:string):AgentToolResult=>({source:"retained_research_catalog",period:null,missing:[code],error:code});
 if(!Number.isSafeInteger(offset)||offset<0||offset>reads.length||budget<=0)return fail("invalid_retained_offset");
 const entries:Array<Record<string,unknown>>=[];
 const base={source:"retained_research_catalog",period:null,missing:[],total:reads.length,page_offset:offset};
 const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),"utf8");
 let size=bytes({...base,entries,next_offset:offset,truncated:true});
 for(let i=offset;i<reads.length&&(limit===null||entries.length<limit);i++){
  const r=reads[i],e=r.result.evidence;
  const entry={ref:r.ref,tool:r.name,source:r.result.source,period:r.result.period,
   receipt_id:e&&typeof e==="object"?(e as Record<string,unknown>).receipt_id??null:null,
   rows:Array.isArray(r.result.rows)?r.result.rows.length:null,
   missing_count:r.result.missing.length,partial:r.result.truncated===true};
  const n=bytes(entry)+(entries.length?1:0);
  if(size+n+64>budget)break;
  entries.push(entry);size+=n;
 }
 const end=offset+entries.length;
 if(end===offset&&offset<reads.length)return {...fail("retained_catalog_exceeds_context"),total:reads.length};
 return {...base,entries,next_offset:end<reads.length?end:null,truncated:end<reads.length};
}

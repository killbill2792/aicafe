import "server-only";
import {z} from "zod";
import {schemaFingerprint,type ReadRegistration} from "../p2/registry";
import type {Observation} from "./evidence";
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const safeKey=(key:string)=>/^(?:[a-zA-Z][a-zA-Z0-9_]*|\d+)$/u.test(key)&&!["constructor","prototype","__proto__"].includes(key);
/** Enumerate paths INSIDE a schema-validated authorized result, never DB tables,
 * process objects or model-supplied records. The model can inspect deeper data
 * without receiving an unbounded source dump. */
export function recordCollections(value:unknown):string[]{
  const paths:string[]=[];
  const walk=(v:unknown,path:string,depth:number)=>{
    if(depth>8||paths.length>=80)return;
    if(Array.isArray(v)){
      paths.push(path);
      v.slice(0,3).forEach((row,i)=>walk(row,path+"."+i,depth+1));
    }else if(record(v))for(const [k,x] of Object.entries(v))if(safeKey(k))walk(x,path+"."+k,depth+1);
  };
  walk(value,"value",0);
  return paths;
}
export const recordInputSchema=z.strictObject({purpose:z.literal("authorized_record_projection"),readId:z.string().regex(/^r\d+$/),
  path:z.string().min(1).max(240),offset:z.number().int().min(0).max(500),limit:z.number().int().min(1).max(25),
  filters:z.array(z.strictObject({field:z.string().min(1).max(120),operator:z.enum(["eq","gte","lte"]),
    value:z.union([z.string().max(500),z.number().finite(),z.boolean(),z.null()])})).max(6)});
const qualitySchema=z.strictObject({missingInputs:z.array(z.string().max(300)).max(200),
  estimatedInputs:z.array(z.string().max(300)).max(200),staleInputs:z.array(z.string().max(300)).max(200)});
const outputSchema=z.union([
  z.strictObject({status:z.literal("unavailable"),value:z.null(),reason:z.string().max(100)}),
  z.strictObject({status:z.literal("partial"),id:z.literal("platform.records.inspect"),
    // Values MUST be selected unchanged from the original validated source.
    // This JSON envelope does not accept model values or new object keys.
    value:z.array(z.json()).max(25),sourceReadId:z.string(),path:z.string(),hasMore:z.boolean(),
    provenance:z.strictObject({sourceId:z.literal("platform.authorized_records"),canonicalReaderId:z.literal("platform.records.inspect"),
      sourceRevision:z.null(),asOf:z.string(),purpose:z.literal("authorized_record_projection")}),quality:qualitySchema}),
]);
export const RECORDS_ID="p3.platform.records.inspect.v1";
export function buildRecordsRegistration(observations:()=>readonly Observation[],businessId:string):ReadRegistration{
  return {id:RECORDS_ID,version:1,owner:"platform",mode:"read",availability:"shadow",currencyPolicy:"independent",
    purpose:"Inspect/filter/page any listed nested record collection from a previously authorized source. Use collections paths from observations, then actual row fields as filters (e.g. employee identity/date/status). No new database data, arbitrary object traversal, record writes or invented values. Inspect another page if hasMore; a page is not a complete count.",
    sourceIds:["platform.authorized_records"],canonicalReaderIds:["platform.records.inspect"],allowedPurposes:["authorized_record_projection"],
    inputSchema:recordInputSchema,outputSchema,schemaContract:{id:RECORDS_ID+".v1",registrationId:RECORDS_ID,version:1,
      inputSchemaFingerprint:schemaFingerprint(recordInputSchema),outputSchemaFingerprint:schemaFingerprint(outputSchema)},
    requiredRole:"owner",sensitivity:"staff",requiresApproval:false,effectPolicy:"deny",
    budgets:{maxOperations:1,timeoutMs:1000,maxInputBytes:6000,maxResultBytes:100000,maxRangeDays:365},
    async read(scope,raw){
      if(scope.businessId!==businessId)return {status:"unavailable",value:null,reason:"unauthorized"};
      const input=recordInputSchema.parse(raw);
      const source=observations().find(o=>o.id===input.readId&&o.reference);
      if(!source||!recordCollections(source.result.value).includes(input.path))
        return {status:"unavailable",value:null,reason:"unknown_record_collection"};
      let collection:unknown=source.result.value;
      for(const key of input.path.split(".").slice(1)){
        if(!safeKey(key)||!(record(collection)||Array.isArray(collection))||!Object.hasOwn(collection,key))
          return {status:"unavailable",value:null,reason:"invalid_record_path"};
        collection=(collection as Record<string,unknown>)[key];
      }
      if(!Array.isArray(collection)||collection.length>2000)return {status:"unavailable",value:null,reason:"record_collection_limit"};
      const fields=new Set(collection.filter(record).flatMap(r=>Object.keys(r).filter(safeKey)));
      if(input.filters.some(f=>!fields.has(f.field)))return {status:"unavailable",value:null,reason:"unknown_record_field"};
      const selected=collection.filter(r=>input.filters.every(f=>{
        if(!record(r)||!Object.hasOwn(r,f.field))return false;
        const value=r[f.field];
        if(f.operator==="eq")return value===f.value;
        if(typeof value==="number"&&typeof f.value==="number")return f.operator==="gte"?value>=f.value:value<=f.value;
        if(typeof value==="string"&&typeof f.value==="string")return f.operator==="gte"?value>=f.value:value<=f.value;
        return false;
      }));
      const quality=qualitySchema.safeParse(source.result.quality);
      return {status:"partial",id:"platform.records.inspect",value:selected.slice(input.offset,input.offset+input.limit),
        sourceReadId:source.id,path:input.path,hasMore:selected.length>input.offset+input.limit,
        provenance:{sourceId:"platform.authorized_records",canonicalReaderId:"platform.records.inspect",sourceRevision:null,
          asOf:scope.identity.asOf,purpose:input.purpose},
        quality:quality.success?quality.data:{missingInputs:["source_quality_unavailable"],estimatedInputs:[],staleInputs:[]}};
    }};
}

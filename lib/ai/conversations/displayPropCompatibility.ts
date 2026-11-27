import {z} from "zod";

/** Shared display-only adaptation against the installed component contracts.
 * Walk the declared structure, including nested objects, arrays and unions.
 * Never invent a required value, alter a financial number, or grant actions.
 * Unrecoverable values remain available to the existing authored-data fallback. */
export function adaptDisplayValue(schema:z.ZodType,value:unknown):unknown{
 const original=schema.safeParse(value);
 if(original.success)return original.data;
 if(value===undefined){
  const nullable=schema.safeParse(null);
  return nullable.success?nullable.data:undefined;
 }
 if(schema instanceof z.ZodOptional||schema instanceof z.ZodNullable||schema instanceof z.ZodDefault){
  return adaptDisplayValue(schema.unwrap() as z.ZodType,value);
 }
 const candidates:unknown[]=[];
 if(typeof value==="number"||typeof value==="boolean")candidates.push(String(value));
 if(typeof value==="string"&&value.trim()){
  if(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)&&Number.isFinite(Number(value)))candidates.push(Number(value));
  if(value==="true"||value==="false")candidates.push(value==="true");
 }
 for(const candidate of candidates){
  const parsed=schema.safeParse(candidate);
  if(parsed.success)return parsed.data;
 }
 if(schema instanceof z.ZodObject&&value!==null&&typeof value==="object"&&!Array.isArray(value)){
  const result={...value as Record<string,unknown>};
  for(const [key,field] of Object.entries(schema.shape as Record<string,z.ZodType>)){
   const adapted=adaptDisplayValue(field,result[key]);
   if(adapted!==undefined)result[key]=adapted;
  }
  const parsed=schema.safeParse(result);
  return parsed.success?parsed.data:result;
 }
 if(schema instanceof z.ZodArray&&Array.isArray(value)){
  return value.map(item=>adaptDisplayValue(schema.element as z.ZodType,item));
 }
 if(schema instanceof z.ZodUnion){
  for(const option of schema.options as readonly z.ZodType[]){
   const adapted=adaptDisplayValue(option,value);
   const parsed=option.safeParse(adapted);
   if(parsed.success)return parsed.data;
  }
 }
 return value;
}
export function adaptDisplayProperties(schema:z.ZodType,properties:Record<string,unknown>):unknown{
 return adaptDisplayValue(schema,properties);
}

import {describe,it,expect} from "vitest";
import {z} from "zod";
import {shadcnComponentDefinitions} from "@json-render/shadcn/catalog";
import {standardComponentDefinitions} from "@json-render/react-pdf/server";
import {adaptDisplayProperties} from "./displayPropCompatibility";

function sample(schema:z.ZodType):unknown{
 if(schema instanceof z.ZodOptional||schema instanceof z.ZodNullable||schema instanceof z.ZodDefault)
  return sample(schema.unwrap() as z.ZodType);
 if(schema instanceof z.ZodObject)return Object.fromEntries(Object.entries(schema.shape as Record<string,z.ZodType>).map(([key,field])=>[key,sample(field)]));
 if(schema instanceof z.ZodArray)return [sample(schema.element as z.ZodType)];
 if(schema instanceof z.ZodEnum)return schema.options[0];
 if(schema instanceof z.ZodUnion){
  for(const option of schema.options as readonly z.ZodType[]){const value=sample(option);if(schema.safeParse(value).success)return value;}
 }
 for(const candidate of ["Example",7,true,null,[],{}])if(schema.safeParse(candidate).success)return candidate;
 throw Error("Missing generated fixture for installed schema: "+JSON.stringify(z.toJSONSchema(schema,{unrepresentable:"any"})));
}
function alternative(schema:z.ZodType,value:unknown):unknown{
 if(schema instanceof z.ZodOptional||schema instanceof z.ZodNullable||schema instanceof z.ZodDefault)
  return alternative(schema.unwrap() as z.ZodType,value);
 if(schema instanceof z.ZodObject&&value!==null&&typeof value==="object"&&!Array.isArray(value)){
  return Object.fromEntries(Object.entries(schema.shape as Record<string,z.ZodType>).filter(([,field])=>!field.safeParse(null).success&&!field.safeParse(undefined).success).map(([key,field])=>[key,alternative(field,(value as Record<string,unknown>)[key])]));
 }
 if(schema instanceof z.ZodArray&&Array.isArray(value))return value.map(item=>alternative(schema.element as z.ZodType,item));
 if(typeof value==="number"||typeof value==="boolean")return String(value);
 return value;
}
describe("catalog-driven display adaptation",()=>{
 const definitions=[...Object.entries(shadcnComponentDefinitions).map(([name,definition])=>({name:"web/"+name,definition})),...Object.entries(standardComponentDefinitions).map(([name,definition])=>({name:"pdf/"+name,definition}))];
 it.each(definitions)("adapts omitted nullable and nested compatible fields: $name",({definition})=>{
  const schema=definition.props;
  const original=sample(schema);
  expect(schema.safeParse(original).success).toBe(true);
  const input=alternative(schema,original) as Record<string,unknown>;
  const normalized=adaptDisplayProperties(schema,input);
  expect(schema.safeParse(normalized).success).toBe(true);
 });
 it("does not invent required properties or discard unconvertible authored values",()=>{
  const schema=z.object({label:z.string(),amount:z.number(),options:z.array(z.object({value:z.string(),caption:z.string().nullable()}))});
  const raw={amount:"unknown",options:[{value:42}]};
  expect(adaptDisplayProperties(schema,raw)).toEqual({amount:"unknown",options:[{value:"42",caption:null}]});
 });
});

import {describe,expect,it} from "vitest";
import {readCompletePaged} from "./completePages";

type Row={id:string;amount_cents:number};
const make=(n:number):Row[]=>Array.from({length:n},(_,i)=>({
 id:"row-"+String(i).padStart(6,"0"),amount_cents:100
}));

describe("complete financial/source pages",()=>{
 it("reads all 2,001 tenant-scoped rows without an implicit 1,000-row cutoff",async()=>{
  const rows=make(2001);const pages:number[]=[];
  const result=await readCompletePaged(async(start,end)=>{
   pages.push(start);
   return {data:rows.slice(start,end+1),count:rows.length,error:null};
  },row=>row.id);
  expect(result).toHaveLength(2001);
  expect(result?.[2000]).toEqual({id:"row-002000",amount_cents:100});
  expect(pages).toEqual([0,1000,2000]);
 });
 it("detects a changed count between ordered pages",async()=>{
  const rows=make(1001);
  const result=await readCompletePaged(async(start,end)=>({
   data:rows.slice(start,end+1),count:start===0?1001:1002,error:null
  }),row=>row.id);
  expect(result).toBeNull();
 });
 it("rejects page overlap, missing identities, and invalid exact counts",async()=>{
  const rows=make(1000);
  const overlapping=await readCompletePaged(async(start)=>({
   data:start===0?rows:[rows[999]],count:1001,error:null
  }),row=>row.id);
  expect(overlapping).toBeNull();
  expect(await readCompletePaged(async()=>({
   data:[{id:"",amount_cents:50}],count:1,error:null
  }),row=>row.id)).toBeNull();
  expect(await readCompletePaged(async()=>({
   data:[{id:"a",amount_cents:50}],count:2,error:null
  }),row=>row.id)).toBeNull();
 });
 it("does not certify failed source pages",async()=>{
  await expect(readCompletePaged(async()=>({
   data:null,error:new Error("source_unavailable"),count:null
  }),row=>(row as Row).id)).rejects.toThrow("source_unavailable");
 });
});

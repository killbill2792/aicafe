import {describe,it,expect} from "vitest";
import {readAllPages} from "./readAllPages";
describe("complete owner history pagination",()=>{
 it("paginates normal two-location 250-day (500 row) history without dropping rows",async()=>{
  const ids=Array.from({length:500},(_,i)=>i);
  const spans:Array<[number,number]>=[];
  const rows=await readAllPages(async(start,end)=>{
   spans.push([start,end]);return {data:ids.slice(start,end+1),error:null};
  });
  expect(rows).toEqual(ids);
  expect(spans).toEqual([[0,199],[200,399],[400,599]]);
 });
 it("continues past 1000 run records",async()=>{
  const records=Array.from({length:1007},(_,i)=>i);
  const result=await readAllPages(async(a,b)=>({data:records.slice(a,b+1),error:null}));
  expect(result).toHaveLength(1007);
  expect(result.at(-1)).toBe(1006);
 });
 it("fails closed on any page error rather than showing a partial money total",async()=>{
  await expect(readAllPages(async(a,b)=>a===0?{data:Array(b+1).fill(1),error:null}:
   {data:null,error:{message:"down"}})).rejects.toThrow("unavailable");
 });
});

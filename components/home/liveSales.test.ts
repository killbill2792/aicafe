import {describe,expect,it} from "vitest";
import {liveSalesView} from "./liveSales";
const reading=(ageMinutes:number)=>({value:{netSalesCents:84_250,readAt:"2026-10-29T17:15:00Z"},ageMs:ageMinutes*60_000});
describe("live sales on Home",()=>{
 it("shows the live reading with the time it was read, in the café's time zone",()=>{
  expect(liveSalesView(reading(5),"America/Los_Angeles","en-US")).toEqual({netSalesCents:84_250,time:"10:15 AM",fresh:true});
 });
 it("labels an older reading as not live, and hides one from an earlier day",()=>{
  expect(liveSalesView(reading(45),"America/Los_Angeles","en-US")?.fresh).toBe(false);
  expect(liveSalesView(reading(13*60),"America/Los_Angeles","en-US")).toBeNull();
  expect(liveSalesView(null,"America/Los_Angeles","en-US")).toBeNull();
 });
});

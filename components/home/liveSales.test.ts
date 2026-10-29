import {describe,expect,it} from "vitest";
import {liveSalesView,needsHomeLiveReading,needsHomeLiveFallback} from "./liveSales";
const reading=(ageMinutes:number,over:Partial<{orders:number;unparsedOrders:number;businessDate:string}>={})=>({
 value:{netSalesCents:84_250,readAt:"2026-10-29T17:15:00Z",businessDate:"2026-10-29",orders:61,unparsedOrders:0,...over},
 ageMs:ageMinutes*60_000});
const tz="America/Los_Angeles";
describe("live sales on Home",()=>{
 it("shows the live reading with the time it was read, in the café's time zone",()=>{
  expect(liveSalesView(reading(5),tz,"en-US","2026-10-29")).toEqual({netSalesCents:84_250,time:"10:15 AM",fresh:true,unreadOrders:0});
 });
 it("labels an older reading as not live",()=>{
  expect(liveSalesView(reading(45),tz,"en-US","2026-10-29")?.fresh).toBe(false);
 });
 it("never shows another business day's reading as today",()=>{
  expect(liveSalesView(reading(5,{businessDate:"2026-10-28"}),tz,"en-US","2026-10-29")).toBeNull();
  expect(liveSalesView(reading(5),tz,"en-US",null)).toBeNull();
  expect(liveSalesView(null,tz,"en-US","2026-10-29")).toBeNull();
 });
 it("uses live sales for missing, zero, or non-final rows, but not a finished import",()=>{
  const date="2026-10-29";
  expect(needsHomeLiveReading(date,[])).toBe(true);
  expect(needsHomeLiveReading(date,[{date,netSalesCents:0,salesDataStatus:"actual"}])).toBe(true);
  expect(needsHomeLiveReading(date,[{date,netSalesCents:12345,salesDataStatus:"missing"}])).toBe(true);
  expect(needsHomeLiveReading(date,[{date,netSalesCents:12345,salesDataStatus:"actual"}])).toBe(false);
  expect(needsHomeLiveReading(null,[])).toBe(false);
 });
 it("uses the Toast business day to reject an old saved reading before closeout",()=>{
  expect(needsHomeLiveFallback(reading(5),"2026-10-29")).toBe(false);
  expect(needsHomeLiveFallback(reading(5),"2026-10-30")).toBe(true);
  expect(needsHomeLiveFallback(null,"2026-10-29")).toBe(true);
  expect(needsHomeLiveFallback(null,null)).toBe(false);
 });
 it("names unreadable orders, and an all-unreadable day has no total",()=>{
  expect(liveSalesView(reading(5,{unparsedOrders:2}),tz,"en-US","2026-10-29")).toMatchObject({netSalesCents:84_250,unreadOrders:2});
  expect(liveSalesView(reading(5,{orders:0,unparsedOrders:4}),tz,"en-US","2026-10-29")).toMatchObject({netSalesCents:null,unreadOrders:4});
 });
});

import {describe,expect,it} from "vitest";
import {hasIncompleteToastLabor,type StagedToastShift,type CanonicalToastShift} from "./laborCoverage";

const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const staged=(n:number,wage:number|null=1500):StagedToastShift=>({
 restaurant_guid:restaurant,external_time_entry_id:String(n),
 clock_in:"2026-10-14T23:00:00Z",clock_out:"2026-10-15T01:00:00Z",
 hourly_wage_cents:wage,provider_regular_hours:2,provider_overtime_hours:0,
 deleted:false,
});
const canonical=(entry:StagedToastShift):CanonicalToastShift=>({
 pos_timecard_id:`toast:${entry.restaurant_guid}:${entry.external_time_entry_id}`,
 clock_in:entry.clock_in,clock_out:entry.clock_out,
 hourly_wage_cents:entry.hourly_wage_cents??0,
 wage_source:"pos",source_type:"connected_pos",
 provider_regular_hours:entry.provider_regular_hours,
 provider_overtime_hours:entry.provider_overtime_hours,
});
describe("Toast canonical labor completeness",()=>{
 it("accepts six then seven matched shifts, including legitimate Toast $0 wages",()=>{
  const source=Array.from({length:7},(_,i)=>staged(i,i===0?null:1500));
  expect(hasIncompleteToastLabor(source.slice(0,6),source.slice(0,6).map(canonical))).toBe(false);
  expect(hasIncompleteToastLabor(source,source.map(canonical))).toBe(false);
 });
 it("detects a partial 6-of-7 promotion, even when the other six are verified",()=>{
  const source=Array.from({length:7},(_,i)=>staged(i));
  expect(hasIncompleteToastLabor(source,source.slice(0,6).map(canonical))).toBe(true);
 });
 it("does not mistake a staged NULL wage for a missing wage on a promoted $0 shift",()=>{
  const row=staged(1,null);
  expect(hasIncompleteToastLabor([row],[canonical(row)])).toBe(false);
  expect(hasIncompleteToastLabor([row],[{...canonical(row),hourly_wage_cents:null}])).toBe(true);
 });
 it("keeps unlinked, unclosed, or non-Toast-app-edited entries incomplete",()=>{
  const row=staged(1);
  expect(hasIncompleteToastLabor([row],[])).toBe(true);
  expect(hasIncompleteToastLabor([{...row,clock_out:null}],[canonical(row)])).toBe(true);
  expect(hasIncompleteToastLabor([row],[{...canonical(row),wage_source:"owner"}])).toBe(true);
 });
 it("detects provider changes to hours, wage, or timestamps and ignores deletions",()=>{
  const row=staged(2);
  expect(hasIncompleteToastLabor([row],[{...canonical(row),hourly_wage_cents:1900}])).toBe(true);
  expect(hasIncompleteToastLabor([row],[{...canonical(row),provider_overtime_hours:1}])).toBe(true);
  expect(hasIncompleteToastLabor([row],[{...canonical(row),clock_out:"2026-10-15T02:00:00Z"}])).toBe(true);
  expect(hasIncompleteToastLabor([{...row,deleted:true}],[])).toBe(false);
 });
});

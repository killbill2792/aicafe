import {describe,it,expect} from "vitest";
import {parseAvailabilityText} from "./parseAvailabilityText";
describe("owner-language availability proposal",()=>{
 it("parses named off days and distinct daily windows without writing anything",()=>{
  const p=parseAvailabilityText("Amy can't work Mon, Tue, Thu; free 6–12 other days");
  expect(p).toMatchObject({personName:"Amy",offDays:[1,2,4],needsOwnerApproval:true});
  expect(p?.availability).toEqual([0,3,5,6].map(day=>({day,start:"06:00",end:"12:00"})));
  expect(p?.assumptions).toHaveLength(1);
 });
 it("recognizes explicit 12-hour times",()=>{
  const p=parseAvailabilityText("Amy cannot work Monday; available 6am–12pm other days");
  expect(p?.availability[0]).toMatchObject({day:0,start:"06:00",end:"12:00"});
  expect(p?.assumptions).toHaveLength(0);
 });
 it("fails closed on unknown names, times, or dates",()=>{
  expect(parseAvailabilityText("Amy can't work Funday; free 6–12 other days")).toBeNull();
  expect(parseAvailabilityText("Amy can't work Mon; free 12–6 other days")).toBeNull();
  expect(parseAvailabilityText("Please schedule Amy")).toBeNull();
 });
});

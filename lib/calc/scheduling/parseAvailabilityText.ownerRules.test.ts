import {describe,it,expect} from "vitest";
import {parseAvailabilityText} from "./parseAvailabilityText";
describe("Supervisor availability phrases for Olivia",()=>{
 it("restricts Amy to Monday, Wednesday and Friday using the existing approved availability writer shape",()=>{
  const parsed=parseAvailabilityText("Amy can only work Mon/Wed/Fri","2026-11-03");
  expect(parsed?.personName).toBe("Amy");
  expect(parsed?.availability.map(x=>x.day)).toEqual([1,3,5]);
  expect(parsed?.offDays).toEqual([0,2,4,6]);
  expect(parsed?.availability[0]).toMatchObject({start:"00:00",end:"23:59"});
  expect(parsed?.needsOwnerApproval).toBe(true);
 });
 it("sends only remaining days this week to the owner-approved exception writer",()=>{
  expect(parseAvailabilityText("Amy can't work this week","2026-11-03")?.offDates)
   .toEqual(["2026-11-03","2026-11-04","2026-11-05","2026-11-06","2026-11-07","2026-11-08"]);
 });
 it("sends the whole following week without any past-day write",()=>{
  expect(parseAvailabilityText("Amy cannot work next week","2026-11-03")?.offDates)
   .toEqual(["2026-11-09","2026-11-10","2026-11-11","2026-11-12","2026-11-13","2026-11-14","2026-11-15"]);
 });
});
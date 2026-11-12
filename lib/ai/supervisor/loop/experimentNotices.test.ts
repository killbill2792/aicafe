import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {nextOwnerPriceReminder,toastObservationNoticeKey} from "./experimentNotices.server";
const base={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 ownerUserId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
 proposalId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
 approvedAt:"2026-03-08T09:00:00Z",timezone:"America/Los_Angeles",
 sourceVerified:false,cancelled:false,prior:[]};
describe("Task 8a owner notice exact source/day/slot identity",()=>{
 it("waits for two real elapsed hours after approval despite spring DST",()=>{
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T10:59:59Z"})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T13:00:00Z"})).toMatchObject({
   kind:"price_reminder",slot:1,localDate:"2026-03-08"});
 });
 it("limits reminder slots by owner/experiment and café-local date",()=>{
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T13:00:00Z",
   prior:[{localDate:"2026-03-08",slot:1}]})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T15:00:00Z",
   prior:[{localDate:"2026-03-08",slot:1}]})).toMatchObject({slot:2});
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T20:00:00Z",
   prior:[{localDate:"2026-03-08",slot:1},{localDate:"2026-03-08",slot:2}]})).toBeNull();
 });
 it("allows a new morning after yesterday's limit and stops when verified",()=>{
  const prior=[{localDate:"2026-03-08",slot:1},{localDate:"2026-03-08",slot:2}];
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T16:00:00Z",prior}))
   .toMatchObject({localDate:"2026-03-09",slot:1});
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T16:00:00Z",prior,
   sourceVerified:true})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T16:00:00Z",prior,
   cancelled:true})).toBeNull();
 });
 it("keeps source history events independent from approved experiment IDs",()=>{
  const event={businessId:base.businessId,ownerUserId:base.ownerUserId,
   priceHistoryId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
   localDate:"2026-11-11"};
  expect(toastObservationNoticeKey({...event,windowIndex:0})).toMatchObject({
   kind:"toast_price_initial",slot:0,sourceId:event.priceHistoryId});
  expect(toastObservationNoticeKey({...event,windowIndex:3})).toMatchObject({
   kind:"toast_price_daily"});
  expect(toastObservationNoticeKey({...event,windowIndex:7,final:true})).toMatchObject({
   kind:"toast_price_final"});
  expect(()=>toastObservationNoticeKey({...event,windowIndex:8})).toThrow();
 });
});

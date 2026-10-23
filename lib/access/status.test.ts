import {describe,it,expect} from "vitest";
import {accessStatus,normalizeCode,validCode} from "./status";
describe("free-access status",()=>{
 it("grandfathers all missing café rows, preserving access on deploy",()=>{
  expect(accessStatus(null).active).toBe(true);
  expect(accessStatus({mode:"grandfathered"}).active).toBe(true);
 });
 it("grants through the end date inclusive and reminds during the final seven days",()=>{
  const d={mode:"code",access_end:"2026-10-30"};
  expect(accessStatus(d,new Date("2026-10-23T23:00:00Z"))).toMatchObject({active:true,daysLeft:7,remind:true});
  expect(accessStatus(d,new Date("2026-10-30T23:59:59Z"))).toMatchObject({active:true,daysLeft:0});
  expect(accessStatus(d,new Date("2026-10-31T00:00:01Z"))).toMatchObject({active:false,remind:false});
 });
 it("respects explicit pause and normalizes case",()=>{
  expect(accessStatus({mode:"paused"}).active).toBe(false);
  expect(normalizeCode(" cafe-abc123 ")).toBe("CAFE-ABC123");
  expect(validCode("cafe-abc123")).toBe(true);
  expect(validCode("x")).toBe(false);
 });
});

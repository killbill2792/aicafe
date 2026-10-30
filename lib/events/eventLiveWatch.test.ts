import {describe,expect,it} from "vitest";
import {withinCafeOpenHours} from "./eventLiveWatch";

describe("planned event live watch respects saved opening hours",()=>{
 it("allows only configured open intervals, including split schedules",()=>{
   const hours={fri:[["07:00","12:00"],["13:00","17:00"]]};
   expect(withinCafeOpenHours([hours],"2026-10-30","08:10")).toBe(true);
   expect(withinCafeOpenHours([hours],"2026-10-30","12:30")).toBe(false);
   expect(withinCafeOpenHours([hours],"2026-10-30","17:00")).toBe(false);
 });
 it("honors overnight open intervals from the previous weekday",()=>{
   const hours={thu:[["22:00","02:00"]]};
   expect(withinCafeOpenHours([hours],"2026-10-30","01:30")).toBe(true);
   expect(withinCafeOpenHours([hours],"2026-10-30","02:01")).toBe(false);
 });
 it("fails closed for missing hours, malformed time and closed days",()=>{
   expect(withinCafeOpenHours([],"2026-10-30","08:00")).toBe(false);
   expect(withinCafeOpenHours([{fri:[]}],"2026-10-30","08:00")).toBe(false);
   expect(withinCafeOpenHours([{fri:[["07:00","17:00"]]}],"bad","08:00")).toBe(false);
   expect(withinCafeOpenHours([{fri:[["07:00","17:00"]]}],"2026-10-30","x")).toBe(false);
 });
});

import {describe,expect,it} from "vitest";
import {completeDays,planDailyCaptures,recentClosedDays} from "./dailyCapture";

const a="aaaaaaaa-0000-4000-8000-000000000001",b="bbbbbbbb-0000-4000-8000-000000000002";
// 2026-10-29 16:00 UTC is 09:00 in Los Angeles: past a 4am closeout, so the 28th is closed.
const now=new Date("2026-10-29T16:00:00Z");
const la={timezone:"America/Los_Angeles",closeoutHour:4};

describe("daily Toast capture planning",()=>{
 it("keeps the last three closed business days, oldest first",()=>{
  expect(recentClosedDays(now,la.timezone,la.closeoutHour)).toEqual(["2026-10-26","2026-10-27","2026-10-28"]);
 });

 it("uses the previous closed day while yesterday is still open",()=>{
  // 10:30 UTC is 03:30 in Los Angeles, before the 4am closeout (+1h settle).
  expect(recentClosedDays(new Date("2026-10-29T10:30:00Z"),la.timezone,la.closeoutHour))
   .toEqual(["2026-10-25","2026-10-26","2026-10-27"]);
 });

 it("skips complete days and retries missing or partial ones",()=>{
  const coverage=[
   {businessId:a,businessDate:"2026-10-26",reason:"available"},
   {businessId:a,businessDate:"2026-10-26",reason:"no_content"},
   {businessId:a,businessDate:"2026-10-27",reason:"available"},
   {businessId:a,businessDate:"2026-10-27",reason:"skipped_time_budget"},
  ];
  expect(planDailyCaptures([{businessId:a,...la}],coverage,now)).toEqual([
   {businessId:a,businessDate:"2026-10-27"},
   {businessId:a,businessDate:"2026-10-28"},
  ]);
 });

 it("treats an endpoint error as a finished capture, not a reason to retry forever",()=>{
  expect(completeDays([{businessId:a,businessDate:"2026-10-28",reason:"missing_permissions"}]))
   .toEqual(new Set([a+"|2026-10-28"]));
 });

 it("plans each café once and never guesses a missing timezone or closeout",()=>{
  const plan=planDailyCaptures([
   {businessId:a,...la},{businessId:a,timezone:"America/New_York",closeoutHour:3},
   {businessId:b,timezone:null,closeoutHour:4},
  ],[],now);
  expect(plan.every(p=>p.businessId===a)).toBe(true);
  expect(plan).toHaveLength(3);
 });
});

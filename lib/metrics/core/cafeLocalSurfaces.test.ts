import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {cafeToday} from "./clock";

const localDateSurfaces=[
 "components/staff/OliviaShiftEditor.tsx",
 "components/staff/OliviaPublicationPanel.tsx",
 "components/operations/SupplierEvidenceManager.tsx",
 "app/[locale]/operations/suppliers/page.tsx",
 "app/api/ai/suppliers/quotes/route.ts",
 "app/api/admin/codes/route.ts",
] as const;

describe("café-local dates cannot silently switch to UTC",()=>{
 it("rejects an implicit UTC wall-time or today fallback on six surfaces",()=>{
  for(const path of localDateSurfaces){
   const source=readFileSync(resolve(process.cwd(),path),"utf8");
   expect(source,path).not.toMatch(/\?\?\s*["']UTC["']/);
   expect(source,path).not.toMatch(/\|\|\s*["']UTC["']/);
   expect(source,path).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/);
  }
 });
 it("the same instant is a different business day in distinct zones",()=>{
  const instant=new Date("2026-10-28T02:15:00Z");
  expect(cafeToday("America/Los_Angeles",instant)).toBe("2026-10-27");
  expect(cafeToday("Asia/Tokyo",instant)).toBe("2026-10-28");
 });
});

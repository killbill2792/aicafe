import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
describe("Home Supervisor composer mobile overlap guard",()=>{
  it("hides only the Home Add Cost floating action on mobile while preserving desktop and other pages",()=>{
    const home=readFileSync("app/[locale]/page.tsx","utf8");
    const fab=readFileSync("components/shared/AddCostFab.tsx","utf8");
    expect(home).toContain("<SupervisorHomePanel");
    expect(home).toContain("<AddCostFab hideOnMobile />");
    expect(fab).toContain('"hidden md:flex"');
    expect(fab).toContain("h-14");
    expect(fab).toContain("bottom-[104px]");
  });
});

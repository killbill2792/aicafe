import { describe,expect,it } from "vitest";
import { localDateInZone } from "./localDate";
describe("Café versus location civil-date defaults",()=>{
  it("chooses different dates across the Pacific at the same instant",()=>{
    const instant=new Date("2026-10-15T00:30:00Z");
    expect(localDateInZone(instant,"America/Los_Angeles")).toBe("2026-10-14");
    expect(localDateInZone(instant,"Asia/Tokyo")).toBe("2026-10-15");
  });
  it("uses named IANA timezone and rejects invalid zones",()=>{
    expect(localDateInZone(new Date("2026-03-08T10:30:00Z"),"America/Los_Angeles"))
      .toBe("2026-03-08");
    expect(()=>localDateInZone(new Date(),"Mars/Olympus")).toThrow();
  });
});

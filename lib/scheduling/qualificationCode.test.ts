import { describe,expect,it } from "vitest";
import { qualificationCodeFromRequestKey } from "./qualificationCode";
describe("Canonical qualification codes are not owner-entered",()=>{
  it("derives one stable, ASCII-safe code for a retried create",()=>{
    const key="3d390582-4cb4-474d-a3a6-605d21e8e982";
    const code=qualificationCodeFromRequestKey(key);
    expect(code).toMatch(/^q_[a-z0-9_]{1,39}$/);
    expect(qualificationCodeFromRequestKey(key)).toBe(code);
  });
  it("distinguishes separate legitimate creates and rejects forged malformed keys",()=>{
    expect(qualificationCodeFromRequestKey("3d390582-4cb4-474d-a3a6-605d21e8e982"))
      .not.toBe(qualificationCodeFromRequestKey("8a891963-a52b-48a2-b92d-bf050ec04bb0"));
    expect(()=>qualificationCodeFromRequestKey("not-a-uuid")).toThrow();
  });
});

import {describe,expect,it} from "vitest";
import {redeemFailureMessage,type RedemptionCopy} from "./redemptionCopy";
const copy:RedemptionCopy={error:"Something went wrong",invalid:"Invalid code",
 expiredCode:"Expired code",full:"All spaces used",rateLimited:"Try later",pausedCafe:"Admin paused AI"};
describe("owner redemption copy",()=>{
 it("never leaks machine status identifiers",()=>{
  for(const status of ["invalid","invalid_code","expired_code","full","rate_limited",
    "paused_cafe","made_up_server_exception",null]){
   const result=redeemFailureMessage(status,copy);
   expect(Object.values(copy)).toContain(result);
   expect(result).not.toContain("_");
  }
 });
 it("keeps admin pauses distinct from ordinary invalid codes",()=>{
  expect(redeemFailureMessage("paused_cafe",copy)).toBe(copy.pausedCafe);
 });
});

import {describe,it,expect} from "vitest";
import {approvedToastLink} from "./ownerMapping";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 r="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
 ext="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
 canon="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
describe("owner operational mapping requires deliberate explicit approval",()=>{
 it.each(["employee","item","modifier"] as const)("will not auto-link %s without selection or approval",kind=>{
  const scope={businessId:b,restaurantGuid:r},source={kind,guid:ext};
  expect(()=>approvedToastLink(scope,source,"",true)).toThrow("Explicit");
  expect(()=>approvedToastLink(scope,source,canon,false)).toThrow("Explicit");
  expect(()=>approvedToastLink(scope,source,"wrong",true)).toThrow();
 });
 it("records the exact tenant, external and manually selected canonical employee",()=>{
  expect(approvedToastLink({businessId:b,restaurantGuid:r},
   {kind:"employee",guid:ext},canon,true)).toEqual({
   action:"link_employee",businessId:b,restaurantGuid:r,
   employeeGuid:ext,canonicalEmployeeId:canon,confirmLink:true
  });
 });
 it.each(["item","modifier"] as const)("links %s without any financial/recipe writes",kind=>{
  expect(approvedToastLink({businessId:b,restaurantGuid:r},
   {kind,guid:ext},canon,true)).toEqual({
   action:"link_catalog",businessId:b,restaurantGuid:r,
   kind,providerGuid:ext,canonicalId:canon,confirmLink:true
  });
 });
});

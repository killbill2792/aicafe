import {describe,expect,it,vi} from "vitest";
import {saveThenVerifyToastConnection} from "./toastConnectFlow";
const config={businessId:"business-1",apiUrl:"https://approved.toasttab.com",
 clientId:"id",clientSecret:"keep-me-secret",
 locations:[{location_id:"l",restaurant_guid:"r"}]};
const reply=(ok:boolean,body:unknown)=>({ok,json:async()=>body}) as Response;
describe("Toast single-action credential save and verification",()=>{
 it("saves once, then verifies using only business ID",async()=>{
  const request=vi.fn().mockResolvedValueOnce(reply(true,{state:"configured"}))
    .mockResolvedValueOnce(reply(true,{state:"verified"}));
  expect(await saveThenVerifyToastConnection(config,request as typeof fetch))
    .toEqual({saved:true,verified:true});
  expect(request.mock.calls.map(c=>c[0])).toEqual(["/api/pos/toast","/api/pos/toast/test"]);
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({businessId:config.businessId});
  expect(JSON.stringify(request.mock.calls[1])).not.toContain(config.clientSecret);
 });
 it("does not try connection verification after failed save",async()=>{
  const request=vi.fn().mockResolvedValueOnce(reply(false,{error:"invalid_host"}));
  expect(await saveThenVerifyToastConnection(config,request as typeof fetch))
    .toEqual({saved:false,verified:false,error:"invalid_host"});
  expect(request).toHaveBeenCalledTimes(1);
 });
 it("does not claim verified after auth rejection",async()=>{
  const request=vi.fn().mockResolvedValueOnce(reply(true,{}))
    .mockResolvedValueOnce(reply(false,{state:"needs_reconnect",error:"authentication"}));
  expect(await saveThenVerifyToastConnection(config,request as typeof fetch))
    .toEqual({saved:true,verified:false,error:"authentication"});
 });
 it("does not claim verified on incomplete responses or outages",async()=>{
  const request=vi.fn().mockResolvedValueOnce(reply(true,{}))
    .mockResolvedValueOnce(reply(true,{state:"configured"}));
  expect((await saveThenVerifyToastConnection(config,request as typeof fetch)).verified).toBe(false);
  const down=vi.fn().mockResolvedValueOnce(reply(true,{}))
    .mockRejectedValueOnce(new Error("offline"));
  expect(await saveThenVerifyToastConnection(config,down as typeof fetch))
    .toEqual({saved:true,verified:false,error:"unavailable"});
 });
});

import {describe,it,expect,vi} from "vitest";
import {loadToastOwnerSetupState} from "./toastSetupState";
const good=(body:unknown,ok=true)=>({ok,json:async()=>body}) as Response;
const uri="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("Toast owner setup status/reload mapping",()=>{
 it("routes connection GUIDs, subscriptions and preference/recovery data to distinct UI states",async()=>{
  const request=vi.fn().mockImplementation(async(path:string)=>{
   if(path.startsWith("/api/pos/toast?"))return good({locations:[
    {restaurant_guid:uri,verified_at:"2026-10-12T19:00:00Z"},
    {restaurant_guid:id,verified_at:null}]});
   if(path.startsWith("/api/pos/toast/webhook/subscriptions?"))return good({subscriptions:[
    {id,enabled:false,webhookUrl:"https://example.org/api/pos/toast/webhook/"+id}]});
   if(path.startsWith("/api/pos/toast/sync-preferences?"))return good({
    preferences:[{kind:"orders",restaurant_guid:uri,enabled:false,
      interval_minutes:60,last_failure_category:null}],
    recovery:[{restaurant_guid:uri,state:"backfilling",kind:"orders"}],
    unresolvedCorrections:[{restaurant_guid:uri,business_date:"2026-10-11"}],
    schedulerActive:false});
   throw new Error("unexpected request");
  });
  const state=await loadToastOwnerSetupState("my cafe",request as typeof fetch);
  expect(state.restaurantGuids).toEqual([uri]);
  expect(state.subscriptions).toMatchObject([{id,enabled:false}]);
  expect(state.status.preferences).toMatchObject([{kind:"orders",enabled:false}]);
  expect(state.status.recovery).toHaveLength(1);
  expect(state.status.unresolvedCorrections).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls.map(c=>c[0])).toEqual([
   "/api/pos/toast?businessId=my%20cafe",
   "/api/pos/toast/webhook/subscriptions?businessId=my%20cafe",
   "/api/pos/toast/sync-preferences?businessId=my%20cafe"]);
 });
 it.each([0,1,2])("fails closed if endpoint %i returns HTTP failure",async failing=>{
  let i=0;
  const request=vi.fn().mockImplementation(async()=>good({},i++!==failing));
  await expect(loadToastOwnerSetupState(uri,request as typeof fetch))
   .rejects.toThrow("unavailable");
 });
 it("rejects malformed/swapped responses rather than treating them as verified",async()=>{
  const request=vi.fn().mockImplementation(async()=>good({subscriptions:[]}));
  await expect(loadToastOwnerSetupState(uri,request as typeof fetch)).rejects.toThrow();
 });
});

import {describe,it,expect,vi} from "vitest";
import {createWebSearch} from "@/lib/ai/agent/webSearch.server";
import type { PublicWebCheckpoint } from "@/lib/luna/shared/publicWebResearch.server";
import { publicResearchIncludesPrivateValue, rememberPrivateWebConversation } from "@/lib/luna/shared/publicWebResearch";
import {executeResearchTool} from "./tools.server";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/connectors/publicWeb.server",()=>({
  ownerPublicWebFetch:vi.fn(),
  PublicWebPermissionError:class extends Error{},
}));
describe("research web cancellation",()=>{
  it("aborts the hosted fetch when the caller's slice ends",async()=>{
    const controller=new AbortController();
    let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const fetcher:typeof fetch=vi.fn(async(_input,init)=>{
      started();
      return new Promise<Response>((_resolve,reject)=>{
        const signal=init?.signal;
        if(signal?.aborted)reject(signal.reason);
        else signal?.addEventListener("abort",()=>reject(signal.reason),{once:true});
      });
    });
    const search=createWebSearch({fetch:fetcher,apiKey:"test",model:"test"});
    const pending=search("public question",undefined,controller.signal);
    await ready;
    controller.abort();
    expect(await pending).toEqual({available:false,reason:"timeout"});
  });
  it("passes the slice signal through the research tool",async()=>{
    const controller=new AbortController();
    const webSearch=vi.fn(async()=>({available:false,reason:"timeout"}));
    await executeResearchTool({db:{} as never,businessId:"cafe",ownerUserId:"owner",webSearch,signal:controller.signal},"search_web",JSON.stringify({query:"public question"}));
    expect(webSearch).toHaveBeenCalledWith("public question",controller.signal);
  });
  it("does not reserve or launch a request after cancellation",async()=>{
    const controller=new AbortController();
    controller.abort();
    const fetcher=vi.fn<typeof fetch>();
    const reserveTransport=vi.fn(async()=>async()=>{});
    const search=createWebSearch({fetch:fetcher,apiKey:"test",model:"test",reserveTransport});
    expect(await search("public question",undefined,controller.signal)).toEqual({available:false,reason:"timeout"});
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserveTransport).not.toHaveBeenCalled();
  });
  it("does not create either transport reservation when the model-call budget denies a lookup",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>(), scheduled=vi.fn(), durable=vi.fn();
    const search=createWebSearch({fetch,apiKey:"test",reserveTransport:scheduled});
    await expect(search("Compare museum admission policies.",{
      reserveModelCall:()=>false,recordUsage:vi.fn(),reserveTransport:durable,
    })).resolves.toEqual({available:false,reason:"budget"});
    expect(scheduled).not.toHaveBeenCalled();
    expect(durable).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not issue a second POST when the provider did not return a response ID",async()=>{
    let saved:PublicWebCheckpoint|undefined;
    const search=createWebSearch({fetch:vi.fn(async()=>{throw new DOMException("Timeout","TimeoutError");}),apiKey:"test"});
    const reserveModelCall=vi.fn(()=>true);
    const continuation={authorize:async()=>1,settle:vi.fn(),save:async(state:PublicWebCheckpoint)=>{saved=state;}};
    const budget={reserveModelCall,recordUsage:vi.fn()};
    expect(await search("Compare museum ticket policies.",{...budget,continuation})).toEqual({available:false,reason:"timeout"});
    expect(saved).toMatchObject({revision:1});
    expect(await search("Compare museum ticket policies.",{...budget,continuation:{...continuation,saved}}))
      .toEqual({available:false,reason:"unverified"});
    expect(reserveModelCall).toHaveBeenCalledTimes(1);
  });
  it("keeps named public research usable alongside privately declared details",()=>{
    const publicObjective="Was the owner of the original Chrysler Building named William Reynolds?";
    const privateText="My client is Clara Valdez. Our internal reference is Hearth-47.";
    const protectedValues=new Set<string>();
    rememberPrivateWebConversation(protectedValues,publicObjective,privateText);
    expect(publicResearchIncludesPrivateValue(publicObjective,protectedValues)).toBe(false);
    expect(publicResearchIncludesPrivateValue("Look up Clara Valdez",protectedValues)).toBe(true);
    expect(publicResearchIncludesPrivateValue("Find Hearth-47",protectedValues)).toBe(true);
  });
});

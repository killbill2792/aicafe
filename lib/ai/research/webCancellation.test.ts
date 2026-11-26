import {describe,it,expect,vi} from "vitest";
import {createWebSearch} from "@/lib/ai/agent/webSearch.server";
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
});

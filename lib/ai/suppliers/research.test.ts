import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {researchEnabled,researchPublicSources} from "./research.server";
afterEach(()=>{delete process.env.SUPPLIER_RESEARCH_ENABLED;delete process.env.BRAVE_SEARCH_API_KEY;});
describe("Public supplier research safeguards",()=>{
 it("does not make external requests without opt-in credentials",async()=>{
  const send=vi.fn();
  expect(researchEnabled()).toBe(false);
  expect(await researchPublicSources("milk suppliers",send)).toEqual([]);
  expect(send).not.toHaveBeenCalled();
 });
 it("marks results unverified and skips HTTP/non-URL sources",async()=>{
  process.env.SUPPLIER_RESEARCH_ENABLED="true";process.env.BRAVE_SEARCH_API_KEY="key";
  const send=vi.fn(async (_url:string)=>({ok:true,json:async()=>({web:{results:[
   {title:"Vendor",url:"https://example.com/milk",description:"Current listing"},
   {title:"Danger",url:"http://example.com/insecure",description:"not returned"},
  ]}})}));
  const rows=await researchPublicSources("milk suppliers",send as unknown as typeof fetch);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({url:"https://example.com/milk",evidenceStatus:"unverified_search_snippet"});
  expect(String(send.mock.calls[0][0])).toContain("api.search.brave.com");
 });
});

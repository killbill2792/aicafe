import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({atomic:vi.fn(),project:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server",()=>({
  readAuthorizedAtomicP1SourceSnapshot:mocks.atomic,
}));
vi.mock("@/lib/supabase/server",()=>({
  createServerSupabaseClient:vi.fn(async()=>({
    from:()=>{
      let selectedId:string|null=null;
      return {
        select(){return this;},
        eq(field:string,value:string){if(field==="id")selectedId=value;return this;},
        limit:()=>mocks.project(selectedId),
      };
    },
  })),
}));

import {alexProductCatalogResolution,alexCatalogChoiceStillValid}
  from "./alexOwnerInput.server";
import type {TrustedReadScope} from "@/lib/ai/supervisor/p2/registry";

const businessId="a0000000-0000-4000-8000-000000000999";
const id12="a0000000-0000-4000-8000-000000000012";
const id16="a0000000-0000-4000-8000-000000000016";
const scope={role:"owner",businessId,
  identity:{businessId,currency:"USD",timezone:"America/Los_Angeles",asOf:"2026-10-21"},
  ownerClause:"Show me my Latte variants",durableOwnerInput:true} as unknown as TrustedReadScope;
let rows:Array<{id:string;name:string;base_name:string;size_label:string;
  is_active:boolean;price_cents:number}>;
let sourceRows:Array<{id:string;name:string;is_active:boolean;price_cents:number}>; 
let revision:string;

beforeEach(()=>{
  revision="100";
  rows=[
    {id:id12,name:"Latte 12 oz",base_name:"Latte",size_label:"12 oz",is_active:true,price_cents:500},
    {id:id16,name:"Latte 16 oz",base_name:"Latte",size_label:"16 oz",is_active:true,price_cents:700},
  ];
  sourceRows=rows.map(r=>({id:r.id,name:r.name,is_active:r.is_active,price_cents:r.price_cents}));
  mocks.project.mockImplementation(async(selectedId:string|null)=>({data:selectedId?
    rows.filter(row=>row.id===selectedId):rows,error:null}));
  mocks.atomic.mockImplementation(async()=>({status:"available",snapshot:{
    businessId,revision,timezone:"America/Los_Angeles",currency:"USD",
    truncated:{menu:false},sources:{menu:sourceRows},
  }}));
});

describe("authenticated menu option identity",()=>{
  it("does not issue interactive catalog cards in read-only P2 shadow contexts",async()=>{
    expect(await alexProductCatalogResolution({...scope,durableOwnerInput:false},{exactName:"Latte"}))
      .toBeNull();
    expect(mocks.project).not.toHaveBeenCalled();
  });
  async function issuedChoice(){
    const request=await alexProductCatalogResolution(scope,{exactName:"Latte"});
    expect(request).toMatchObject({mode:"resolve",input:{kind:"options"}});
    if(!request||!("writeContext" in request))throw new Error("Expected owner question");
    expect(request.input.kind).toBe("options");
    return request;
  }
  it("finds both size variants under a family selector and binds the issued identity",async()=>{
    const request=await issuedChoice();
    const fingerprint=request.writeContext["catalogIdentity:"+id12];
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await alexCatalogChoiceStillValid(businessId,id12,fingerprint)).toBe(true);
  });
  it("allows unrelated revision changes while keeping the same menu identity",async()=>{
    const request=await issuedChoice();
    revision="101";
    expect(await alexCatalogChoiceStillValid(businessId,id12,
      request.writeContext["catalogIdentity:"+id12])).toBe(true);
  });
  it("rejects a renamed active product rather than accepting only its UUID",async()=>{
    const request=await issuedChoice();
    rows[0].name="Espresso 12 oz";
    sourceRows[0].name="Espresso 12 oz";
    expect(await alexCatalogChoiceStillValid(businessId,id12,
      request.writeContext["catalogIdentity:"+id12])).toBe(false);
  });
  it("rejects an item moved to another family even if its visible name did not change",async()=>{
    const request=await issuedChoice();
    rows[0].base_name="Espresso";
    expect(await alexCatalogChoiceStillValid(businessId,id12,
      request.writeContext["catalogIdentity:"+id12])).toBe(false);
  });
  it("rejects removed and unissued choices",async()=>{
    const request=await issuedChoice();
    rows[0].is_active=false;
    sourceRows[0].is_active=false;
    expect(await alexCatalogChoiceStillValid(businessId,id12,
      request.writeContext["catalogIdentity:"+id12])).toBe(false);
    expect(await alexCatalogChoiceStillValid(businessId,id16,"")).toBe(false);
  });
});

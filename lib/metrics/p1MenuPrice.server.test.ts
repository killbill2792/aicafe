import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({client:vi.fn(),menu:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:mocks.client}));
vi.mock("@/lib/data/getMenuItemsForEdit",()=>({getMenuItemsForEdit:mocks.menu}));
vi.mock("@/lib/scheduling/foundationSchemas",()=>({foundationTables:{}}));
import {readP1MenuCatalog,readP1Recipe} from "./p1Additional.server";
import {values} from "./p1Catalog";

const row=(id:string,price_cents:number|null)=>({
  id,business_id:"cafe-1",name:"Espresso",category:"drink",
  is_active:true,price_cents,
});
const limit=vi.fn(),order=vi.fn(()=>({limit}));
const maybeSingle=vi.fn();
const eq=vi.fn(()=>({eq,order,maybeSingle}));
const select=vi.fn(()=>({eq}));
const from=vi.fn(()=>({select}));
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.client.mockResolvedValue({from});
  limit.mockResolvedValue({data:[row("p1",null),row("p2",0)],error:null});
  maybeSingle.mockResolvedValue({data:{id:"p1",price_cents:null},error:null});
  mocks.menu.mockResolvedValue({ingredients:[],items:[{
    id:"p1",name:"Espresso",priceCents:0,costStatus:"READY",recipe:[],
  }]});
});
describe("P1 menu price source fidelity",()=>{
  it("retains unpriced records as NULL, not an invented $0, and preserves recorded zero",async()=>{
    const data=await readP1MenuCatalog({businessId:"cafe-1"});
    expect(data).toMatchObject({available:true,value:[
      {id:"p1",priceCents:null,priceStatus:"unrecorded"},
      {id:"p2",priceCents:0,priceStatus:"recorded"},
    ]});
    expect(data.available && data.quality.missingInputs).toContain("menu_items_missing_recorded_price:1");
    expect(values["menu.catalog"].safeParse(data.value).success).toBe(true);
    expect(select).toHaveBeenCalledWith("id,business_id,name,category,is_active,price_cents");
    expect(eq).toHaveBeenCalledWith("business_id","cafe-1");
    expect(limit).toHaveBeenCalledWith(501);
  });
  it("does not trust a UI editor's synthetic zero-price fallback in a recipe",async()=>{
    const result=await readP1Recipe({businessId:"cafe-1"},"p1");
    expect(result).toMatchObject({available:true,value:{
      id:"p1",priceCents:null,priceStatus:"unrecorded",costStatus:"READY",
    }});
    expect(result.available && result.quality.missingInputs).toContain("menu_item_price_unrecorded");
    expect(values["menu.recipe"].safeParse(result.value).success).toBe(true);
    expect(eq).toHaveBeenCalledWith("id","p1");
  });
  it("denies cross-business catalog rows instead of projecting them",async()=>{
    limit.mockResolvedValue({data:[{...row("secret",100),business_id:"other-cafe"}],error:null});
    expect(await readP1MenuCatalog({businessId:"cafe-1"})).toMatchObject({
      available:false,value:null,
    });
  });
  it("rejects inconsistent menu price status at the schema boundary",()=>{
    const item={id:"p1",name:"X",category:"drink",active:true,
      priceCents:null,priceStatus:"recorded"};
    expect(values["menu.catalog"].safeParse([item]).success).toBe(false);
    expect(values["menu.catalog"].safeParse([{...item,priceStatus:"unrecorded"}]).success).toBe(true);
    expect(values["menu.catalog"].safeParse([{...item,priceCents:0,priceStatus:"unrecorded"}]).success).toBe(false);
  });
});

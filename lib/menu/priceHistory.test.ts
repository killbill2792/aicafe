import {describe,it,expect,vi,beforeEach} from "vitest";
import {setCanonicalMenuPrice} from "./priceHistory";
import type {SupabaseClient} from "@supabase/supabase-js";

const rpc=vi.fn();
const client={rpc} as unknown as SupabaseClient;
const input={
  businessId:"11111111-1111-4111-8111-111111111111",
  menuItemId:"22222222-2222-4222-8222-222222222222",
  priceCents:500,sourceType:"owner_manual" as const,
  sourceProvider:"Alex (owner approved)",
};
beforeEach(()=>{rpc.mockReset();rpc.mockResolvedValue({data:true,error:null});});

describe("Menu's canonical price writer",()=>{
  it("retains the original RPC for ordinary Menu and POS writes",async()=>{
    expect(await setCanonicalMenuPrice(client,input)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_menu_item_price_with_history",{
      p_business_id:input.businessId,p_menu_item_id:input.menuItemId,
      p_new_price_cents:500,p_source_type:"owner_manual",
      p_source_provider:"Alex (owner approved)",
    });
  });
  it("uses only the compare-and-swap RPC for an approved proposal",async()=>{
    expect(await setCanonicalMenuPrice(client,{...input,expectedOldPriceCents:450})).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_menu_item_price_with_history_if_current",{
      p_business_id:input.businessId,p_menu_item_id:input.menuItemId,
      p_expected_old_price_cents:450,p_new_price_cents:500,
      p_source_type:"owner_manual",p_source_provider:"Alex (owner approved)",
    });
  });
  it("does not fall back to an unconditional save if the baseline is stale",async()=>{
    rpc.mockResolvedValue({data:false,error:null});
    expect(await setCanonicalMenuPrice(client,{...input,expectedOldPriceCents:450})).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("set_menu_item_price_with_history_if_current");
  });
  it("fails closed if the new RPC is unavailable",async()=>{
    rpc.mockResolvedValue({data:null,error:new Error("missing migration")});
    await expect(setCanonicalMenuPrice(client,{...input,expectedOldPriceCents:450}))
      .rejects.toThrow("missing migration");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

import {describe,expect,it} from "vitest";
import {reconcileAttributedItemRevenue,reconcileItemUnitsToCanonical} from "./reconcileItemRevenue";
describe("provider-neutral net item attribution",()=>{
  it("accepts line amounts only after every order net amount reconciles",()=>{
    const result=reconcileAttributedItemRevenue([
      {id:"order1",netSalesCents:1500},{id:"order2",netSalesCents:500},
    ],[
      {orderId:"order1",itemId:"latte",quantity:2,revenueCents:1200},
      {orderId:"order1",itemId:"tea",quantity:1,revenueCents:300},
      {orderId:"order2",itemId:"latte",quantity:1,revenueCents:500},
    ]);
    expect(result.verified).toBe(true);
    expect(result.items).toContainEqual({itemId:"latte",units:3,revenueCents:1700});
  });
  it("rejects a Square-style order discount not allocated to lines",()=>{
    const result=reconcileAttributedItemRevenue([{id:"discount",netSalesCents:900}],[
      {orderId:"discount",itemId:"latte",quantity:1,revenueCents:1000},
    ]);
    expect(result.verified).toBe(false);
  });
  it("rejects a Toast-style refunded check with unreconciled selection amounts",()=>{
    expect(reconcileAttributedItemRevenue([{id:"refund",netSalesCents:300}],[
      {orderId:"refund",itemId:"coffee",quantity:1,revenueCents:1000},
    ]).verified).toBe(false);
  });
  it("rejects absent, overflowed or orphaned lines instead of treating them as zero",()=>{
    expect(reconcileAttributedItemRevenue([{id:"one",netSalesCents:500}],[]).verified).toBe(false);
    expect(reconcileAttributedItemRevenue([],[
      {orderId:"ghost",itemId:"x",quantity:1,revenueCents:500},
    ]).verified).toBe(false);
    expect(reconcileAttributedItemRevenue([{id:"one",netSalesCents:10}],[
      {orderId:"one",itemId:"x",quantity:1,revenueCents:1e30},
    ]).verified).toBe(false);
  });
});


describe("canonical item quantity proof",()=>{
  it("detects a PostgREST-capped detail where canonical SQL counted all 1200",()=>{
    expect(reconcileItemUnitsToCanonical([{itemId:"coffee",units:1000}],
      [{id:"coffee",units:1200}])).toBe(false);
  });
  it("cannot turn an item only beyond the fetched page into zero",()=>{
    expect(reconcileItemUnitsToCanonical([{itemId:"coffee",units:1000}],
      [{id:"coffee",units:1000},{id:"latte",units:1}])).toBe(false);
  });
  it("accepts exactly reconciled complete quantities",()=>{
    expect(reconcileItemUnitsToCanonical([{itemId:"coffee",units:1200}],
      [{id:"coffee",units:1200}])).toBe(true);
  });
});

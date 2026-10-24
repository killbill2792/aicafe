import { describe, expect, it } from "vitest";
import { homeAttentionHref, homeShiftHref, prioritizeHomeAttention, type HomeAttentionItem } from "./homeAttention";

describe("Home attention", () => {
  it("routes each actionable source to the correct fix", () => {
    expect(homeAttentionHref({kind:"bill",category:"rent"})).toBe("/more/bills?category=rent");
    expect(homeAttentionHref({kind:"bill",category:"utilities_power"})).toBe("/more/bills?category=utilities_power");
    expect(homeAttentionHref({kind:"missing_sales",toastConnected:true})).toBe("/more/toast");
    expect(homeAttentionHref({kind:"missing_sales",toastConnected:false})).toBe("/more/uploads/sales");
    expect(homeAttentionHref({kind:"fees"})).toBe("/more/processing-fees");
    expect(homeAttentionHref({kind:"unmatched"})).toBe("/menu/import-review");
    expect(homeAttentionHref({kind:"pantry"})).toBe("/menu/pantry");
    expect(homeAttentionHref({kind:"reconnect",provider:"toast"})).toBe("/more/toast");
    expect(homeAttentionHref({kind:"reconnect",provider:"square"})).toBe("/more");
    expect(homeAttentionHref({kind:"alert",href:"/more/alerts/one#voids-review"})).toBe("/more/alerts/one#voids-review");
    expect(homeAttentionHref({kind:"price",href:"/menu/item/one"})).toBe("/menu/item/one");
    expect(homeAttentionHref({kind:"staff",href:"/staff?tab=schedule&date=2026-10-23&employee=abc"})).toBe("/staff?tab=schedule&date=2026-10-23&employee=abc");
    expect(homeAttentionHref({kind:"task",href:"/operations?status=needs_you"})).toBe("/operations?status=needs_you");
    expect(homeAttentionHref({kind:"alert",href:"https://example.org/"})).toBe("/operations");
  });

  it("preserves employee and date context when linking to the live schedule", () => {
    expect(homeShiftHref("employee 42", "2026-10-23")).toBe(
      "/staff?tab=schedule&employee=employee+42&date=2026-10-23");
    expect(homeShiftHref()).toBe("/staff?tab=schedule");
  });

  it("sorts by known monetary impact, caps at 5, preserves stable unknown order and deduplicates", () => {
    const items: HomeAttentionItem[] = [
      {id:"a",title:"a",href:"/operations",actionLabel:"Fix",impactCents:null},
      {id:"b",title:"b",href:"/operations",actionLabel:"Fix",impactCents:300},
      {id:"c",title:"c",href:"/operations",actionLabel:"Fix",impactCents:100},
      {id:"d",title:"d",href:"/operations",actionLabel:"Fix",impactCents:500},
      {id:"e",title:"e",href:"/operations",actionLabel:"Fix",impactCents:null},
      {id:"f",title:"f",href:"/operations",actionLabel:"Fix",impactCents:0},
      {id:"d",title:"d",href:"/operations",actionLabel:"Fix",impactCents:500},
    ];
    const result = prioritizeHomeAttention(items);
    expect(result.total).toBe(6);
    expect(result.visible.map(item => item.id)).toEqual(["d","b","c","f","a"]);
    expect(items[0].id).toBe("a");
  });

  it("exposes an empty feed without creating a fake item", () => {
    expect(prioritizeHomeAttention([])).toEqual({visible:[],total:0});
  });
});

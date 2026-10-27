import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSquareAdapter, normalizeSquareProcessingFeeCents } from "./adapter";
import { squarePaginated, squareRequest } from "./client";

vi.mock("./client", () => ({ squarePaginated: vi.fn(), squareRequest: vi.fn() }));

const order = { id: "order-1", closed_at: "2026-10-02T12:00:00Z", total_money: { amount: 1_500 }, line_items: [] };
const range = { since: new Date("2026-10-02T00:00:00Z"), until: new Date("2026-10-03T00:00:00Z") };

beforeEach(() => {vi.mocked(squarePaginated).mockReset();vi.mocked(squareRequest).mockReset();});

async function fetchWithPayments(payments: unknown[]) {
  vi.mocked(squarePaginated).mockResolvedValueOnce([order]).mockResolvedValueOnce(payments);
  return (await createSquareAdapter({ accessToken: "secret", locationId: "location" }).fetchOrders(range))[0];
}

describe("Square processing fees", () => {
  it("normalizes one already-netted signed fee into positive processing cost", () => {
    expect(normalizeSquareProcessingFeeCents(-44)).toBe(44);
    expect(normalizeSquareProcessingFeeCents(44)).toBe(44);
    expect(normalizeSquareProcessingFeeCents(0)).toBe(0);
  });

  it("maps a completed card fee to positive actual provenance", async () => {
    expect(await fetchWithPayments([{
      order_id: "order-1", status: "COMPLETED", source_type: "CARD",
      processing_fee: [{ amount_money: { amount: -44 } }],
    }])).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });

  it("nets mixed-sign fee adjustments before normalizing the final cost", async () => {
    expect(await fetchWithPayments([{
      order_id: "order-1", status: "COMPLETED", source_type: "CARD",
      processing_fee: [{ amount_money: { amount: -44 } }, { amount_money: { amount: 10 } }],
    }])).toMatchObject({ processingFeeCents: 34, processingFeeStatus: "actual" });
  });

  it("treats completed cash as known actual zero", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "COMPLETED", source_type: "CASH" }]))
      .toMatchObject({ processingFeeCents: 0, processingFeeStatus: "actual" });
  });

  it("treats completed external tender as known actual zero", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "COMPLETED", source_type: "EXTERNAL" }]))
      .toMatchObject({ processingFeeCents: 0, processingFeeStatus: "actual" });
  });

  it("keeps a completed card missing until Square exposes its fee", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "COMPLETED", source_type: "CARD" }]))
      .toMatchObject({ processingFeeCents: 0, processingFeeStatus: "missing" });
  });

  it("keeps pending/approved economically applicable payments incomplete", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "PENDING", source_type: "CARD" }]))
      .toMatchObject({ processingFeeStatus: "missing" });
  });

  it("ignores failed/canceled attempts when a completed payment is valid", async () => {
    expect(await fetchWithPayments([
      { order_id: "order-1", status: "FAILED", source_type: "CARD" },
      { order_id: "order-1", status: "CANCELED", source_type: "CARD" },
      { order_id: "order-1", status: "COMPLETED", source_type: "CARD", processing_fee: [{ amount_money: { amount: -44 } }] },
    ])).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });

  it("supports split tender with card fee plus legitimate zero-fee cash", async () => {
    expect(await fetchWithPayments([
      { order_id: "order-1", status: "COMPLETED", source_type: "CARD", processing_fee: [{ amount_money: { amount: -44 } }] },
      { order_id: "order-1", status: "COMPLETED", source_type: "CASH" },
      { order_id: "order-1", status: "FAILED", source_type: "CARD" },
    ])).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });

  it("allows a later resync to move a card fee from missing to actual", async () => {
    vi.mocked(squarePaginated)
      .mockResolvedValueOnce([order])
      .mockResolvedValueOnce([{ order_id: "order-1", status: "COMPLETED", source_type: "CARD" }])
      .mockResolvedValueOnce([order])
      .mockResolvedValueOnce([{
        order_id: "order-1", status: "COMPLETED", source_type: "CARD",
        processing_fee: [{ amount_money: { amount: -44 } }],
      }]);
    const adapter = createSquareAdapter({ accessToken: "secret", locationId: "location" });
    expect((await adapter.fetchOrders(range))[0]).toMatchObject({ processingFeeCents: 0, processingFeeStatus: "missing" });
    expect((await adapter.fetchOrders(range))[0]).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });
});

describe("Square catalog and published shifts",()=>{
 it("copies individual size prices, category display name, and priced modifier groups",async()=>{
  vi.mocked(squareRequest).mockResolvedValueOnce({objects:[
   {id:"C1",type:"CATEGORY",category_data:{name:"Espresso"}},
   {id:"O1",type:"MODIFIER",modifier_data:{name:"Oat milk",price_money:{amount:75}}},
   {id:"G1",type:"MODIFIER_LIST",modifier_list_data:{name:"Milk",modifiers:[{id:"O1"}]}},
   {id:"I1",type:"ITEM",item_data:{name:"Latte",category_id:"C1",description:"Fresh espresso",
     modifier_list_info:[{modifier_list_id:"G1",min_selected_modifiers:1,max_selected_modifiers:1}],
     variations:[
      {id:"SM",item_variation_data:{name:"Small",price_money:{amount:450}}},
      {id:"LG",item_variation_data:{name:"Large",price_money:{amount:550},
       location_overrides:[{location_id:"location",price_overrides:true,price_money:{amount:575}}]}}
     ]}}
  ]});
  const items=await createSquareAdapter({accessToken:"token",locationId:"location"}).fetchCatalogItems();
  expect(items).toHaveLength(2);
  expect(items).toMatchObject([
   {posItemId:"SM",name:"Latte",baseName:"Latte",sizeLabel:"Small",priceCents:450,
    category:"Espresso",description:"Fresh espresso",modifierGroups:[{
     posGroupId:"G1",required:true,options:[{posModifierId:"O1",name:"Oat milk",priceCents:75}]
    }]},
   {posItemId:"LG",name:"Latte",baseName:"Latte",sizeLabel:"Large",priceCents:575,
    category:"Espresso"}
  ]);
  expect(vi.mocked(squareRequest).mock.calls[0][1]).toContain("types=ITEM");
 });
 it("uses API-published status and café-location scope for scheduled shifts",async()=>{
  const q={id:"S1",published_shift_details:{location_id:"location",team_member_id:"T1",
   start_at:"2026-10-27T17:00:00Z",end_at:"2026-10-27T21:00:00Z"}};
  vi.mocked(squareRequest)
   .mockResolvedValueOnce({scheduled_shifts:[q,{...q,id:"another",published_shift_details:{
    ...q.published_shift_details,location_id:"another"}}],cursor:"next"})
   .mockResolvedValueOnce({scheduled_shifts:[{...q,id:"S2",published_shift_details:{
     ...q.published_shift_details,start_at:"2026-11-20T17:00:00Z",end_at:"2026-11-20T21:00:00Z"}}]});
  const shifts=await createSquareAdapter({accessToken:"token",locationId:"location"})
    .fetchPosScheduledShifts!({since:new Date("2026-10-27T00:00:00Z"),until:new Date("2026-10-29T00:00:00Z")});
  expect(shifts).toMatchObject([{externalShiftId:"S1",externalEmployeeId:"T1",
   scheduledStart:"2026-10-27T17:00:00Z",deleted:false}]);
  const req=vi.mocked(squareRequest).mock.calls[0][2] as {method:string;body:{query:{filter:{location_ids:string[];scheduled_shift_statuses:string[]}};limit:number}};
  expect(req.method).toBe("POST");
  expect(req.body.query.filter).toMatchObject({
   location_ids:["location"],scheduled_shift_statuses:["PUBLISHED"],
  });
  expect(req.body).toHaveProperty("limit",50);
  expect((vi.mocked(squareRequest).mock.calls[1][2] as {body:{cursor:string}}).body.cursor).toBe("next");
 });
});

describe("Square nullable wage provenance",()=>{
 it("preserves missing hourly wages as unknown rather than claiming a zero rate",async()=>{
  vi.mocked(squarePaginated).mockResolvedValueOnce([
   {id:"missing",team_member_id:"staff",start_at:"2026-10-02T10:00:00Z"},
   {id:"zero",team_member_id:"staff",start_at:"2026-10-02T11:00:00Z",
    wage:{hourly_rate:{amount:0}}}
  ]);
  const cards=await createSquareAdapter({accessToken:"token",locationId:"location"}).fetchTimecards(range);
  expect(cards.map(card=>card.hourlyWageCents)).toEqual([null,0]);
 });
});

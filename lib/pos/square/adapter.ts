import "server-only";
import { squarePaginated, squareRequest } from "./client";
import type { PosAdapter, PosCatalogItem, PosEmployee, PosOrder, PosTimecard, PosScheduledShift } from "../types";

type SquareMoney = { amount?: number; currency?: string };
type SquareOrderLineItem = {
  catalog_object_id?: string;
  name?: string;
  quantity?: string;
  total_money?: SquareMoney;
  modifiers?: { catalog_object_id?: string; name?: string; quantity?:string;
    base_price_money?:SquareMoney;total_price_money?:SquareMoney }[];
};
type SquareOrder = {
  id: string;
  location_id?: string;
  closed_at?: string;
  created_at?: string;
  total_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  total_tip_money?: SquareMoney;
  net_amounts?: { total_money?: SquareMoney };
  line_items?: SquareOrderLineItem[];
  refunds?: { amount_money?: SquareMoney }[];
  employee_id?:string;ticket_name?:string;
  fulfillments?:Array<{type?:string;state?:string}>;
  tenders?:Array<{employee_id?:string}>;
};
type SquarePayment = {
  order_id?: string;
  status?: string;
  source_type?: string;
  processing_fee?: { amount_money?: SquareMoney }[];
};

function cents(money: SquareMoney | undefined): number {
  return money?.amount ?? 0;
}

/** Normalize one already-netted Square fee amount into AI Cafe's positive-cost convention. */
export function normalizeSquareProcessingFeeCents(netAmountCents: number): number {
  return Math.abs(Math.round(netAmountCents));
}

function classifySquarePaymentFee(payment: SquarePayment): { applicable: boolean; complete: boolean; amountCents: number } {
  const status = payment.status?.toUpperCase();
  if (status === "FAILED" || status === "CANCELED") return { applicable: false, complete: true, amountCents: 0 };
  if (status !== "COMPLETED") return { applicable: true, complete: false, amountCents: 0 };

  const sourceType = payment.source_type?.toUpperCase();
  if (sourceType === "CASH" || sourceType === "EXTERNAL") {
    return { applicable: true, complete: true, amountCents: 0 };
  }

  if (payment.processing_fee !== undefined) {
    const signedNet = payment.processing_fee.reduce((sum, entry) => sum + cents(entry.amount_money), 0);
    return { applicable: true, complete: true, amountCents: normalizeSquareProcessingFeeCents(signedNet) };
  }

  // Completed fee-bearing/unknown tender with no fee yet: remain conservative until Square
  // supplies the processing_fee entries on a later sync.
  return { applicable: true, complete: false, amountCents: 0 };
}

/**
 * Maps Square's Orders/Payments/Catalog/Team-Member/Timecard APIs onto the shared PosAdapter
 * shape. Field names follow Square's documented v2 API as of Square-Version 2025-05-21 — confirm
 * against Square's current docs before relying on this against a live merchant (per
 * docs/06-integrations.md), and verify one day's totals against Square's own Sales Summary /
 * Labor reports before trusting a real sync.
 */
export function createSquareAdapter(params: { accessToken: string; locationId: string }): PosAdapter {
  const { accessToken, locationId } = params;

  return {
    provider: "square",

    async fetchOrders({ since, until }) {
      const orders = await squarePaginated<SquareOrder>(
        accessToken,
        "/v2/orders/search",
        {
          location_ids: [locationId],
          query: {
            filter: {
              date_time_filter: { closed_at: { start_at: since.toISOString(), end_at: until.toISOString() } },
              state_filter: { states: ["COMPLETED"] },
            },
            sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
          },
          limit: 500,
        },
        "orders",
      );

      // Processing fees live on Payments, matched back to their order. Failed/canceled attempts
      // are ignored; legitimate zero-fee completed tenders count as complete actual zero.
      const payments = await squarePaginated<SquarePayment>(
        accessToken,
        "/v2/payments",
        { location_id: locationId, begin_time: since.toISOString(), end_time: until.toISOString() },
        "payments",
      );
      const feeByOrder = new Map<string, { amountCents: number; complete: boolean; applicableCount: number }>();
      for (const payment of payments) {
        if (!payment.order_id) continue;
        const classified = classifySquarePaymentFee(payment);
        if (!classified.applicable) continue;
        const prior = feeByOrder.get(payment.order_id) ?? { amountCents: 0, complete: true, applicableCount: 0 };
        feeByOrder.set(payment.order_id, {
          amountCents: prior.amountCents + classified.amountCents,
          complete: prior.complete && classified.complete,
          applicableCount: prior.applicableCount + 1,
        });
      }

      const result: PosOrder[] = orders.map((order) => {
        const discounts = cents(order.total_discount_money);
        const refunds = (order.refunds ?? []).reduce((sum, r) => sum + cents(r.amount_money), 0);
        const gross = cents(order.total_money);
        const net = order.net_amounts?.total_money ? cents(order.net_amounts.total_money) : gross - discounts - refunds;

        const processingFee = feeByOrder.get(order.id);
        const processingFeeComplete = Boolean(processingFee && processingFee.applicableCount > 0 && processingFee.complete);
        return {
          posOrderId: order.id,
          posLocationId: order.location_id ?? locationId,
          posEmployeeId: order.employee_id??order.tenders?.find(t=>t.employee_id)?.employee_id??null,
          diningOption:order.fulfillments?.[0]?.type??null,
          sourceChannel:order.fulfillments?.[0]?.type??null,
          guestCount:null,
          closedAt: order.closed_at ?? order.created_at ?? new Date().toISOString(),
          grossSalesCents: gross,
          discountsCents: discounts,
          refundsCents: refunds,
          taxCents: cents(order.total_tax_money),
          tipCents: cents(order.total_tip_money),
          processingFeeCents: processingFee?.amountCents ?? 0,
          processingFeeStatus: processingFeeComplete ? "actual" : "missing",
          netSalesCents: net,
          lines: (order.line_items ?? []).map((line) => ({
            posItemId: line.catalog_object_id ?? null,
            name: line.name ?? "Item",
            quantity: Number(line.quantity ?? "1"),
            netSalesCents: cents(line.total_money),
            modifiers: (line.modifiers ?? []).map((m) => ({
              posModifierId: m.catalog_object_id ?? "",name: m.name ?? "",
              quantity: m.quantity == null ? 1 : Number(m.quantity),
              priceCents: m.total_price_money?.amount ?? m.base_price_money?.amount ?? null,
              parentPosModifierId: null,
            })),
            voided: false,
            voidedBy: null,
          })),
        };
      });

      return result;
    },

    async fetchCatalogItems(): Promise<PosCatalogItem[]> {
      type CatalogObject={
        id:string;type:string;
        category_data?:{name?:string};
        modifier_data?:{name?:string;price_money?:SquareMoney};
        modifier_list_data?:{name?:string;modifiers?:Array<{id?:string;modifier_data?:{name?:string;price_money?:SquareMoney}}>;selection_type?:string};
        item_variation_data?:{name?:string;item_id?:string;price_money?:SquareMoney;pricing_type?:string;
          location_overrides?:Array<{location_id?:string;price_money?:SquareMoney;price_overrides?:boolean}>};
        item_data?:{name?:string;description?:string;category_id?:string;
          variations?:Array<{id?:string;item_variation_data?:{name?:string;price_money?:SquareMoney;pricing_type?:string;
          location_overrides?:Array<{location_id?:string;price_money?:SquareMoney;price_overrides?:boolean}>}}>;
          modifier_list_info?:Array<{modifier_list_id?:string;min_selected_modifiers?:number;max_selected_modifiers?:number}>};
      };
      const all:CatalogObject[]=[];
      let cursor:string|undefined;
      for(let i=0;i<50;i++){
        const search=new URLSearchParams({types:"ITEM,ITEM_VARIATION,CATEGORY,MODIFIER_LIST,MODIFIER"});
        if(cursor)search.set("cursor",cursor);
        const page=await squareRequest<{objects?:CatalogObject[];cursor?:string}>(
          accessToken,"/v2/catalog/list?"+search.toString());
        all.push(...(page.objects??[]));
        if(!page.cursor)break;
        cursor=page.cursor;
        if(i===49)throw new Error("Square catalog pagination incomplete");
      }
      const byId=new Map(all.map(row=>[row.id,row]));
      const categories=new Map(all.filter(row=>row.type==="CATEGORY")
        .map(row=>[row.id,row.category_data?.name??"Uncategorized"]));
      const items:PosCatalogItem[]=[];
      for(const object of all.filter(row=>row.type==="ITEM")){
        const base=object.item_data?.name??"Item";
        const infos=object.item_data?.modifier_list_info??[];
        const modifierGroups=infos.flatMap(info=>{
          const list=info.modifier_list_id?byId.get(info.modifier_list_id):null;
          if(!list||list.type!=="MODIFIER_LIST")return [];
          const options=(list.modifier_list_data?.modifiers??[]).flatMap(option=>{
            const raw=option.id?byId.get(option.id):null;
            const data=raw?.modifier_data??option.modifier_data;
            if(!option.id||!data)return [];
            return [{posModifierId:option.id,name:data.name??"Modifier",
              priceCents:data.price_money?.amount??null,pricingStrategy:null}];
          });
          return [{posGroupId:list.id,name:list.modifier_list_data?.name??"Modifiers",
            minSelections:info.min_selected_modifiers??null,
            maxSelections:info.max_selected_modifiers??null,
            required:(info.min_selected_modifiers??0)>0,options}];
        });
        const variations=object.item_data?.variations??[];
        for(const variation of variations){
          const v=variation.id?byId.get(variation.id)?.item_variation_data??variation.item_variation_data:
            variation.item_variation_data;
          if(!variation.id)continue;
          const size=v?.name??null;
          items.push({posItemId:variation.id,name:base,baseName:base,sizeLabel:size,
            priceCents:v?.location_overrides?.find(row=>row.location_id===locationId&&row.price_overrides)?.price_money?.amount??v?.price_money?.amount??null,
            category:categories.get(object.item_data?.category_id??"")??null,
            description:object.item_data?.description??null,
            modifierGroups});
        }
        if(!variations.length)items.push({
          posItemId:object.id,name:base,baseName:base,sizeLabel:null,
          priceCents:null,category:categories.get(object.item_data?.category_id??"")??null,
          description:object.item_data?.description??null,modifierGroups
        });
      }
      return items;
    },

    async fetchEmployees(): Promise<PosEmployee[]> {
      type TeamMember = { id: string; given_name?: string; family_name?: string; status?: string };
      const data = await squareRequest<{ team_members?: TeamMember[] }>(accessToken, "/v2/team-members/search", {
        method: "POST",
        body: { query: {} },
      });
      return (data.team_members ?? []).map((m) => ({
        posTeamMemberId: m.id,
        displayName: [m.given_name, m.family_name].filter(Boolean).join(" ") || "Team member",
        role: null,active:m.status!=="INACTIVE",
      }));
    },

    async fetchPosScheduledShifts({since,until}):Promise<PosScheduledShift[]> {
      type Raw={id?:string;published_shift_details?:{location_id?:string;team_member_id?:string;
        job_id?:string;start_at?:string;end_at?:string;is_deleted?:boolean}};
      const list:Raw[]=[];
      let cursor:string|undefined;
      for(let n=0;n<50;n++){
        const result=await squareRequest<{scheduled_shifts?:Raw[];cursor?:string}>(
          accessToken,"/v2/labor/scheduled-shifts/search",{
            method:"POST",body:{query:{filter:{
              location_ids:[locationId],
              start:{end_at:until.toISOString()},
              end:{start_at:since.toISOString()},
              scheduled_shift_statuses:["PUBLISHED"]
            }},limit:50,...(cursor?{cursor}:{})}
          });
        list.push(...(result.scheduled_shifts??[]));
        if(!result.cursor)break;
        cursor=result.cursor;
        if(n===49)throw new Error("Square scheduled shifts pagination incomplete");
      }
      return list.flatMap(shift=>{
        const d=shift.published_shift_details;
        if(!shift.id||!d||d.location_id!==locationId||!d.team_member_id||
          !d.start_at||!d.end_at)return [];
        if(Date.parse(d.start_at)>=until.getTime()||Date.parse(d.end_at)<=since.getTime())return [];
        return [{externalShiftId:shift.id,externalEmployeeId:d.team_member_id,
          externalJobId:d.job_id??null,scheduledStart:d.start_at,scheduledEnd:d.end_at,
          deleted:d.is_deleted??false}];
      });
    },
    async fetchTimecards({ since, until }): Promise<PosTimecard[]> {
      type Timecard = {
        id: string;
        team_member_id: string;
        start_at?: string;
        end_at?: string;
        wage?: { hourly_rate?: SquareMoney };
        breaks?: { start_at?: string; end_at?: string; is_paid?: boolean }[];
      };
      const timecards = await squarePaginated<Timecard>(
        accessToken,
        "/v2/labor/timecards/search",
        { query: { filter: { location_ids: [locationId], start: { start_at: since.toISOString(), end_at: until.toISOString() } } } },
        "timecards",
      );
      return timecards
        .filter((tc) => tc.start_at)
        .map((tc) => ({
          posTimecardId: tc.id,
          posTeamMemberId: tc.team_member_id,
          clockIn: tc.start_at!,
          clockOut: tc.end_at ?? null,
          hourlyWageCents: tc.wage?.hourly_rate?.amount ?? null,
          breaks: (tc.breaks ?? [])
            .filter((b) => b.start_at && b.end_at)
            .map((b) => ({ start: b.start_at!, end: b.end_at!, paid: Boolean(b.is_paid) })),
        }));
    },
  };
}

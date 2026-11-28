import {readProviderPages} from "@/lib/externalData/pages";
import "server-only";
import { squarePaginated, squareRequest } from "./client";
import type {squareArchive} from "./sourceArchive.server";
import type { CatalogPriceSource, PosAdapter, PosCatalogItem, PosEmployee, PosOrder, PosTimecard } from "../types";

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
  tenders?:Array<{employee_id?:string;payment_id?:string}>;
};
type SquarePayment = {
  id?: string;
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

  if (Array.isArray(payment.processing_fee) && payment.processing_fee.length > 0) {
    const amounts = payment.processing_fee.map(entry => entry?.amount_money?.amount);
    if (!amounts.every((amount): amount is number => typeof amount === "number" && Number.isSafeInteger(amount))) {
      return { applicable: true, complete: false, amountCents: 0 };
    }
    const signedNet = amounts.reduce((sum, amount) => sum + amount, 0);
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
export function createSquareAdapter(params: { accessToken: string; locationId: string;
  archive?: ReturnType<typeof squareArchive>
}): PosAdapter {
  const { accessToken, locationId } = params;
  const archive = params.archive;

  return {
    provider: "square",
    bindCatalogSources:params.archive?.bindCatalogSources,

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
        "orders", params.archive?.("orders","ORDERS_READ"),
      );

      // Processing fees live on Payments, matched back to their order. Failed/canceled attempts
      // are ignored; legitimate zero-fee completed tenders count as complete actual zero.
      const payments = await squarePaginated<SquarePayment>(
        accessToken,
        "/v2/payments",
        { location_id: locationId, begin_time: since.toISOString(), end_time: until.toISOString() },
        "payments", params.archive?.("payments","PAYMENTS_READ"), "GET",
      );
      const feeByOrder = new Map<string, { amountCents: number; complete: boolean; applicableCount: number; paymentIds: Set<string> }>();
      for (const payment of payments) {
        if (!payment.order_id) continue;
        const classified = classifySquarePaymentFee(payment);
        if (!classified.applicable) continue;
        const total = feeByOrder.get(payment.order_id) ?? { amountCents: 0, complete: true, applicableCount: 0, paymentIds: new Set<string>() };
        total.amountCents += classified.amountCents;
        total.complete &&= classified.complete;
        total.applicableCount += 1;
        if (payment.id) total.paymentIds.add(payment.id);
        feeByOrder.set(payment.order_id, total);
      }

      const result: PosOrder[] = orders.map((order) => {
        const discounts = cents(order.total_discount_money);
        const refunds = (order.refunds ?? []).reduce((sum, r) => sum + cents(r.amount_money), 0);
        const gross = cents(order.total_money);
        const net = order.net_amounts?.total_money ? cents(order.net_amounts.total_money) : gross - discounts - refunds;

        const processingFee = feeByOrder.get(order.id);
        // ListPayments is eventually consistent and filters on payment creation time,
        // whereas SearchOrders uses closing time. Match each known tender before
        // certifying an order that declares its payment identities.
        const tenderPaymentIds = order.tenders?.flatMap(tender => tender.payment_id ? [tender.payment_id] : []) ?? [];
        const processingFeeComplete = Boolean(processingFee && processingFee.applicableCount > 0 && processingFee.complete && (
          tenderPaymentIds.length === 0 || (
            new Set(tenderPaymentIds).size === order.tenders?.length &&
            tenderPaymentIds.length === processingFee.applicableCount &&
            tenderPaymentIds.every(id => processingFee.paymentIds.has(id))
          )
        ));
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
        id:string;type:string;version?:number;
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
      const read = params.archive?.("catalog","ITEMS_READ");
      const fetchPage = async (_query: Record<string,unknown>, cursor: string | null) => {
        const search = new URLSearchParams();
        if (cursor) search.set("cursor",cursor);
        const page = await squareRequest<{objects?:CatalogObject[];cursor?:string}>(
          accessToken,"/v2/catalog/list"+(search.size ? "?"+search : ""));
        return {items:page.objects ?? [], next:page.cursor ?? null};
      };
      const all = await (read ? read({},fetchPage) : readProviderPages(cursor=>fetchPage({},cursor)));
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
        for(const [index,variation] of variations.entries()){
          if(!variation.id)continue;
          const separateRecord=byId.get(variation.id);
          const separate=separateRecord?.item_variation_data;
          const v=separate??variation.item_variation_data;
          const override=v?.location_overrides?.findIndex(row=>row.location_id===locationId&&row.price_overrides)??-1;
          const overrideAmount=v?.location_overrides?.[override]?.price_money?.amount;
          const priceCents=overrideAmount??v?.price_money?.amount??null;
          const basePath=separate?["item_variation_data"]:["item_data","variations",String(index),"item_variation_data"];
          const path=overrideAmount==null?[...basePath,"price_money","amount"]:
            [...basePath,"location_overrides",String(override),"price_money","amount"];
          const version=separate ? separateRecord?.version : object.version;
          const checks:NonNullable<CatalogPriceSource["checks"]>=[];
          if(version!==undefined)checks.push({path:["version"],value:version});
          if(!separate)checks.push({path:["item_data","variations",String(index),"id"],value:variation.id});
          if(overrideAmount!=null){
            const overridePath=[...basePath,"location_overrides",String(override)];
            checks.push({path:[...overridePath,"location_id"],value:locationId},
              {path:[...overridePath,"price_overrides"],value:true});
          }
          const size=v?.name??null;
          items.push({posItemId:variation.id,name:base,baseName:base,sizeLabel:size,
            priceCents,priceSource:priceCents===null?null:{recordKey:separate?variation.id:object.id,path,checks},
            category:categories.get(object.item_data?.category_id??"")??null,
            description:object.item_data?.description??null,
            pricingStrategy:v?.pricing_type??null,
            modifierGroups});
        }
        if(!variations.length)items.push({
          posItemId:object.id,name:base,baseName:base,sizeLabel:null,
          priceCents:null,priceSource:null,category:categories.get(object.item_data?.category_id??"")??null,
          description:object.item_data?.description??null,modifierGroups
        });
      }
      return items;
    },

    async fetchEmployees(): Promise<PosEmployee[]> {
      type TeamMember = { id: string; given_name?: string; family_name?: string; status?: string };
      const members = await squarePaginated<TeamMember>(accessToken, "/v2/team-members/search",
        {query: {filter: {location_ids: [locationId]}}}, "team_members", params.archive?.("team_members","EMPLOYEES_READ"));
      return members.map((m) => ({
        posTeamMemberId: m.id,
        displayName: [m.given_name, m.family_name].filter(Boolean).join(" ") || "Team member",
        role: null,active:m.status!=="INACTIVE",
      }));
    },

    syncPublishedSchedule: archive && (async ({since,until}) => {
      const read = archive("scheduled_shifts","TIMECARDS_READ");
      const query = {query:{filter:{
        location_ids:[locationId],
        start:{end_at:until.toISOString()},
        end:{start_at:since.toISOString()},
        scheduled_shift_statuses:["PUBLISHED"]
      }},limit:50};
      const fetchPage = async (body: Record<string,unknown>, cursor: string | null) => {
        const result=await squareRequest<{scheduled_shifts?:unknown[];cursor?:string;errors?:unknown}>(
          accessToken,"/v2/labor/scheduled-shifts/search",{
            method:"POST",body:cursor?{...body,cursor}:body
          });
        if (result.errors || (result.scheduled_shifts != null && !Array.isArray(result.scheduled_shifts))) {
          throw new Error("Incomplete Square schedule response");
        }
        return {items:result.scheduled_shifts ?? [],next:result.cursor ?? null};
      };
      await read(query,fetchPage);
      await archive.applyPublishedSchedule(query);
    }),
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
        "timecards", params.archive?.("timecards","TIMECARDS_READ"),
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

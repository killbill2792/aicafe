import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {snapshotToastBusinessDay,matchToastReport,reportSchema} from "./pilot";
import {ToastApiError} from "./client";
const guid="00000000-0000-4000-8000-000000000001";
const order={posOrderId:"toast:"+guid+":00000000-0000-4000-8000-000000000002",
 posLocationId:guid,closedAt:"2026-10-11T08:00:00Z",
 grossSalesCents:1200,netSalesCents:1000,discountsCents:200,refundsCents:0,
 taxCents:75,tipCents:200,processingFeeStatus:"missing" as const,processingFeeCents:0,
 lines:[{posItemId:"toast:"+guid+":00000000-0000-4000-8000-000000000003",
 name:"Latte",quantity:2,netSalesCents:1000,modifiers:[],voided:false,voidedBy:null}]};
describe("Toast staged business-day reconciliation",()=>{
 it("is deterministic and preserves integer sales, counts and product quantities",()=>{
 const snapshot=snapshotToastBusinessDay([order],"2026-10-10",guid);
 expect(snapshot).toMatchObject({order_count:1,gross_sales_cents:1200,net_sales_cents:1000,
   discounts_cents:200,tax_cents:75,tip_cents:200});
 expect(Object.values(snapshot.product_quantities)).toEqual([2]);
 expect(snapshot.snapshot_sha256).toBe(snapshotToastBusinessDay([order],"2026-10-10",guid).snapshot_sha256);
 const report={orderCount:1,grossSalesCents:1200,netSalesCents:1000,discountsCents:200,
    refundsCents:0,taxCents:75,tipCents:200,productQuantities:snapshot.product_quantities};
 expect(matchToastReport(snapshot,report)).toBe(true);
 expect(matchToastReport(snapshot,{...report,netSalesCents:999})).toBe(false);
 });
 it("does not promote a zero day without matched owner report",()=>{
 const snapshot=snapshotToastBusinessDay([],"2026-10-10",guid);
 expect(snapshot.order_count).toBe(0);
 expect(matchToastReport(snapshot,{orderCount:1,grossSalesCents:0,netSalesCents:0,
    discountsCents:0,refundsCents:0,taxCents:0,tipCents:0,productQuantities:{}})).toBe(false);
 });
 it("rejects foreign order IDs or duplicate IDs rather than double counting",()=>{
 expect(()=>snapshotToastBusinessDay([order,order],"2026-10-10",guid)).toThrow(ToastApiError);
 expect(()=>snapshotToastBusinessDay([{...order,posOrderId:"other"}],"2026-10-10",guid)).toThrow(ToastApiError);
 });
 it("validates owner-supplied report totals",()=>{
 expect(reportSchema.safeParse({orderCount:-1}).success).toBe(false);
 });
});

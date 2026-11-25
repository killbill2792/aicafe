import {describe,expect,it} from "vitest";
import {isOwnerActionableAlert,OWNER_INPUT_GAP_SUBJECTS} from "./ownerActionable";

const gap=(subject:string)=>({family:"data_gap",subject,quality:"missing",current:1,previous:0,unit:"coverage"});
describe("owner-actionable alerts",()=>{
  it("keeps real business alerts",()=>{
    expect(isOwnerActionableAlert("meal_break",{dedupeKey:"t1"})).toBe(true);
    expect(isOwnerActionableAlert("voids",{})).toBe(true);
    expect(isOwnerActionableAlert("business_anomaly",{family:"live_sales_decline",subject:"cafe"})).toBe(true);
    expect(isOwnerActionableAlert("business_anomaly",{family:"customer_trend",subject:"returning"})).toBe(true);
  });
  it("keeps data gaps only when the owner holds the missing input",()=>{
    for(const subject of OWNER_INPUT_GAP_SUBJECTS)expect(isOwnerActionableAlert("business_anomaly",gap(subject))).toBe(true);
  });
  it("hides system conditions: reader outages, import lag and derived coverage",()=>{
    for(const subject of ["reader_unavailable:cost_recovery","reader_unavailable:expenses","sales_coverage","live_sales_coverage",
      "hourly_staff_pressure_coverage","customer_identity_coverage","operating_margin_coverage","cost_recovery_coverage",
      "refund_order_cohort_coverage","product_recipe_history"])
      expect(isOwnerActionableAlert("business_anomaly",gap(subject)),subject).toBe(false);
  });
});

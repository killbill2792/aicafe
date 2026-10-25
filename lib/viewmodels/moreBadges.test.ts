import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildMoreBadges } from "./moreBadges";

describe("More attention badges", () => {
  it("flags missing and partial hours, not explicitly closed days", () => {
    expect(buildMoreBadges({ openHours: null }).hoursNotSet).toBe(true);
    expect(buildMoreBadges({ openHours: { mon: [["08:00", "17:00"]] } }).hoursNotSet).toBe(true);
    expect(buildMoreBadges({ openHours: {mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: []} }).hoursNotSet).toBe(false);
    expect(buildMoreBadges({}).hoursNotSet).toBe(false);
  });
  it("requires verified Toast credentials, location, and healthy sync", () => {
    const toast={state:"verified",hasError:false,verifiedLocation:true};
    expect(buildMoreBadges({toast}).toast).toBe("connected");
    expect(buildMoreBadges({toast:{...toast,state:"configured"}}).toast).toBe("needsAttention");
    expect(buildMoreBadges({toast:{...toast,hasError:true}}).toast).toBe("needsAttention");
    expect(buildMoreBadges({toast:{...toast,verifiedLocation:false}}).toast).toBe("needsAttention");
    expect(buildMoreBadges({toast:null}).toast).toBeNull();
  });
  it("counts review uploads and gives a real review ID", () => {
    const badges=buildMoreBadges({uploads:[{id:"r",status:"needs_review"},{id:"d",status:"done"},{id:"f",status:"failed"}]});
    expect(badges.uploadsNeedingReview).toBe(1);
    expect(badges.firstUploadToReview).toBe("r");
    expect(buildMoreBadges({uploads:[]}).uploadsNeedingReview).toBe(0);
  });
  it("distinguishes fee gaps and unknown coverage", () => {
    expect(buildMoreBadges({missingFeeDays:3}).missingFeeDays).toBe(3);
    expect(buildMoreBadges({missingFeeDays:0}).missingFeeDays).toBe(0);
    expect(buildMoreBadges({}).missingFeeDays).toBeNull();
  });
  it("checks rent and converts recurring bills to monthly cents", () => {
    const rent={id:"r",categoryCode:"rent" as const,label:"Rent",amountCents:100000,frequency:"monthly" as const,dueDay:null,isEstimate:false};
    const water={...rent,id:"w",categoryCode:"water" as const,amountCents:1200,frequency:"weekly" as const};
    expect(buildMoreBadges({bills:[]}).rentMissing).toBe(true);
    expect(buildMoreBadges({bills:[rent,water]}).monthlyBills)
      .toEqual({ amountCents: 105200, includesEstimates: false });
    expect(buildMoreBadges({bills:[rent]}).rentMissing).toBe(false);
    expect(buildMoreBadges({}).monthlyBills).toBeNull();
    expect(buildMoreBadges({}).rentMissing).toBe(false); // query unavailable, not missing rent
    expect(buildMoreBadges({bills:[{...rent,amountCents:0}]}).monthlyBills)
      .toEqual({ amountCents: 0, includesEstimates: false });
  });
  it("keeps estimated versus actual provenance alongside the total, even when mixed", () => {
    const actual={id:"rent",categoryCode:"rent" as const,label:"Rent",amountCents:200000,
      frequency:"monthly" as const,dueDay:null,isEstimate:false};
    const estimate={id:"water",categoryCode:"water" as const,label:"Water",amountCents:6000,
      frequency:"monthly" as const,dueDay:null,isEstimate:true};
    expect(buildMoreBadges({bills:[actual,estimate]}).monthlyBills)
      .toEqual({amountCents:206000,includesEstimates:true});
    expect(buildMoreBadges({bills:[estimate]}).monthlyBills)
      .toEqual({amountCents:6000,includesEstimates:true});
    expect(buildMoreBadges({bills:[actual]}).monthlyBills)
      .toEqual({amountCents:200000,includesEstimates:false});
    expect(buildMoreBadges({bills:[{...estimate,amountCents:0}]}).monthlyBills)
      .toEqual({amountCents:0,includesEstimates:true});
    expect(buildMoreBadges({bills:[]}).monthlyBills)
      .toEqual({amountCents:0,includesEstimates:false});
  });
  it("shows alert count including zero, not unknown as zero", () => {
    expect(buildMoreBadges({alertCount:0}).alerts).toBe(0);
    expect(buildMoreBadges({alertCount:2}).alerts).toBe(2);
    expect(buildMoreBadges({}).alerts).toBeNull();
  });
});
describe("More navigation", () => {
  const page=readFileSync("app/[locale]/more/page.tsx","utf8");
  it("does not link to onboarding or legacy manage-staff",()=>{
    expect(page).toContain('href="/staff"');
    expect(page).toContain('href="/more/plan"');
    expect(page).toContain('href="/more/access"');
    expect(page).toContain('href="/more/toast"');
    expect(page).not.toContain("/onboarding");
    expect(page).not.toContain("/more/manage-staff");
    expect(page).not.toContain("connectRegister");
  });
  it.each(["en","es","ar"])("has all new More strings in %s",(lang)=>{
    const t=JSON.parse(readFileSync(`messages/${lang}.json`,"utf8")).More;
    for(const key of ["yourCafe","yourData","planGoals","settings","language","appearance","staffSchedule","hoursNotSet","connected","needsAttention","uploadsNeedReview","feesDaysMissing","rentMissing","monthlyAmount","monthlyAmountEstimated","signedInAs"])
      expect(t[key]).toBeTruthy();
  });
  it("renders mixed estimate totals with a distinct translated label",()=>{
    expect(page).toContain('badges.monthlyBills.includesEstimates ? "monthlyAmountEstimated" : "monthlyAmount"');
    for(const lang of ["en","es","ar"]){
      const t=JSON.parse(readFileSync(`messages/${lang}.json`,"utf8")).More;
      expect(t.monthlyAmountEstimated).toContain("{amount}");
      expect(t.monthlyAmountEstimated).not.toBe(t.monthlyAmount);
      expect(t.monthlyAmountEstimated.toLowerCase()).toMatch(lang==="en"?/estimat/:lang==="es"?/estimac/:/تقدير/);
    }
  });
  it("removes Money and Menu header language controls",()=>{
    for(const name of ["money","menu"])
      expect(readFileSync(`app/[locale]/${name}/page.tsx`,"utf8")).not.toContain("<LanguageSwitch");
  });
});

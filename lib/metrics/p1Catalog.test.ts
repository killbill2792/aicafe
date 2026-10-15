import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classified, discoverP1, inputFor, metricIds, metricUnits, purposePolicies,
  PUBLIC_TOOL_METHODS, readers, sourcePolicies, values, additionalSurfaces } from "./p1Catalog";

describe("Platform P1 checked-in coverage manifest", () => {
  it("has bidirectional coverage of every public business-scoped facade method", () => {
    const source=readFileSync(new URL("../ai/tools.ts",import.meta.url),"utf8");
    const methods=source.split("export class BusinessScopedCafeTools")[1]
      .matchAll(/^\s{2}([a-zA-Z]\w+)\(/gm);
    const actual=[...methods].map(m=>m[1]).filter(m=>m!=="constructor").sort();
    expect(actual).toEqual([...PUBLIC_TOOL_METHODS].sort());
    const facadeMethods=new Set<string>(PUBLIC_TOOL_METHODS);
    const exposed=[...new Set(Object.values(readers).filter(method=>facadeMethods.has(method)))];
    expect([...exposed,...Object.keys(classified)].sort()).toEqual(actual);
  });
  it("has a strict value and request contract, exact source-purpose policy, handler and identity for each ID", () => {
    const ids=Object.keys(values).sort();
    expect(Object.keys(readers).sort()).toEqual(ids);
    expect(Object.keys(purposePolicies).sort()).toEqual(ids);
    expect(Object.keys(sourcePolicies).sort()).toEqual(ids);
    const discovered=discoverP1();
    expect(discovered).toHaveLength(ids.length);
    expect(discovered.map(d=>d.id).sort()).toEqual(ids);
    for(const id of ids as (keyof typeof values)[]) {
      const definition=discovered.find(d=>d.id===id)!;
      const purposes=purposePolicies[id] as readonly string[];
      expect(Object.keys(sourcePolicies[id]).sort()).toEqual([...purposes].sort());
      expect(definition.canonicalReader).toBe(readers[id]);
      expect(definition.canonicalSourcePath).toMatch(/^lib\\/);
      expect(definition.selectorContractId).toBe(id+".selector");
      expect(definition.selectorContractVersion).toBe(1);
      expect(definition.querySchemaContractId).toBe(id+".query");
      expect(definition.resultSchemaContractId).toBe(id+".result");
      expect(definition.querySchemaVersion).toBe(1);
      expect(definition.resultSchemaVersion).toBe(1);
      expect(definition.authorization).toBe("selected_business_owner_session_RLS");
      for(const purpose of purposes) {
        const policy=sourcePolicies[id][purpose];
        expect(policy.sourcePurpose).toBe(purpose);
        expect(policy.canonicalReaderId).toBe(readers[id]);
        expect(policy.readerContractVersion).toBe(1);
        expect(policy.selectorContractVersion).toBe(1);
        expect(policy.precedencePolicyRevision).toBe(1);
      }
      expect(inputFor(id).safeParse({id,version:1,purpose:"forged"}).success).toBe(false);
      expect(values[id].safeParse(undefined).success).toBe(false);
    }
    expect(metricIds.length).toBeGreaterThan(0);
    for(const metricId of metricIds){
      expect(values[metricId].safeParse(metricUnits[metricId]==="ratio"?0.25:123).success).toBe(true);
      expect(values[metricId].safeParse(metricUnits[metricId]==="ratio"?Infinity:1.5).success).toBe(false);
      expect(inputFor(metricId).safeParse({id:metricId,version:1,purpose:purposePolicies[metricId][0],granularity:"hour",period:{from:"2026-10-01",to:"2026-10-10"}}).success).toBe(false);
    }
    expect(Object.keys(additionalSurfaces).length).toBeGreaterThan(0);
  });
  it("disallows extra filters, SQL strings, fake versions, impossible dates and hourly inference", () => {
    const base={id:"sales.daily",version:1,purpose:"actual_daily_sales",
      period:{from:"2026-10-01",to:"2026-10-14"}};
    const s=inputFor("sales.daily");
    expect(s.safeParse(base).success).toBe(true);
    for(const bad of [
      {...base,granularity:"hour"},
      {...base,query:"select * from timecards"},
      {...base,version:2},
      {...base,purpose:"labor_forecast"},
      {...base,period:{from:"2026-10-10",to:"2026-10-01"}},
      {...base,period:{from:"2026-02-30",to:"2026-03-01"}},
      {...base,period:{from:"2024-10-01",to:"2026-10-01"}},
    ])expect(s.safeParse(bad).success).toBe(false);
  });
  it("rejects malformed money, booleans masquerading as counts and extra confidential fields",()=>{
    const s=values["money.monthly_bills"];
    for(const value of [42.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,"300",true])
      expect(s.safeParse({totalCents:value}).success).toBe(false);
    expect(s.safeParse({totalCents:0}).success).toBe(true);
    expect(s.safeParse({totalCents:1000,internalToken:"secret"}).success).toBe(false);
    const pricing=values["pricing.recommendation"];
    expect(pricing.safeParse({status:"PRICE_UNAVAILABLE",recommendedPriceCents:0}).success).toBe(false);
  });
});

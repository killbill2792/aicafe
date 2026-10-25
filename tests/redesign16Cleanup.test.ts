import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Translations = Record<string, Record<string, string>>;

function localeMessages(locale: string): Translations {
  return JSON.parse(readFileSync(resolve(process.cwd(), "messages", `${locale}.json`), "utf8")) as Translations;
}

const requiredKeys: Record<string, string[]> = {
  ToastConnect: ["ownerImportFrom", "ownerRepull", "ownerStatusUnavailable"],
  Staff: ["payrollCostsSummary", "payrollCostsEdit", "payrollSaveFailed"],
  Onboarding: ["payrollTaxInvalid", "payrollTaxSaveFailed"],
  SupervisorChat: ["clarifyOther", "howIGotThis", "explainSubtract"],
  StaffSchedule: ["nudgeEarlier", "prepareScheduleMessages", "multiplier"],
  Home: ["keyNumbers", "needsAttention", "attentionSalesMissing"],
  More: ["yourCafe", "signedInAs", "toastDaysLook"],
  CardValues: ["perHour", "fieldSchedule"],
  ManageStaff: ["wagePeriodHour", "wagePeriodMonth", "wagePeriodYear"],
  OliviaPlanning: ["revisionDraft", "publishError", "ruleLoadError", "invalidWallTime"],
};

describe("redesign 16 cleanup integration", () => {
  for (const locale of ["en", "es", "ar"]) {
    it(`keeps current owner-facing translations after cleanup in ${locale}`, () => {
      const messages = localeMessages(locale);
      for (const [namespace, keys] of Object.entries(requiredKeys)) {
        for (const key of keys) {
          expect(messages[namespace]?.[key], `${locale}:${namespace}.${key}`).toEqual(expect.any(String));
        }
      }
    });
  }

  it("keeps English, Spanish, and Arabic translation keys in sync", () => {
    const keys = (locale: string) => {
      const messages = localeMessages(locale);
      return Object.entries(messages)
        .flatMap(([namespace, values]) => Object.keys(values).map(key => `${namespace}.${key}`))
        .sort();
    };
    expect(keys("es")).toEqual(keys("en"));
    expect(keys("ar")).toEqual(keys("en"));
  });

  it("removes only the four no-longer-imported components", () => {
    for (const path of [
      "components/staff/ManageStaffPanel.tsx",
      "components/staff/OliviaPlanningPanel.tsx",
      "components/staff/SchedulingInputsPanel.tsx",
      "components/more/EditBusinessName.tsx",
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }
  });
});

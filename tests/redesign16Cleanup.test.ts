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

// AGENTS.md requires new owner-facing strings only in messages/en.json. The
// original localized keys retain strict three-locale parity; these exact
// Task14B namespace+key pairs are deliberately English-only, never a wildcard.
const approvedTask14bEnglishOnly: Record<string, readonly string[]> = {
  "SupplierPurchaseOrderCard": [
    "ariaLabel",
    "agentLabel",
    "titlePrefix",
    "approved",
    "pending",
    "applying",
    "requestedBy",
    "unspecified",
    "at",
    "perPack",
    "lineSubtotal",
    "quoted",
    "delivery",
    "unconfirmed",
    "sourceQuote",
    "itemsSubtotal",
    "subtotalNotice",
    "ownerNotice",
    "approve",
    "decline",
    "checkingReceipt",
    "reconcile",
    "approvalError"
  ],
  "SupplierEvidenceExtras": [
    "quoteCurrency",
    "availability",
    "notConfirmed",
    "ownerConfirmed",
    "unavailable",
    "availabilityCheckedOn",
    "expires",
    "deliveryDate",
    "dateUnknown",
    "delivery",
    "expiry",
    "unknown"
  ]
};
const approvedTask14bSet = new Set(Object.entries(approvedTask14bEnglishOnly)
  .flatMap(([namespace, keys]) => keys.map(key => namespace+"."+key)));

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

  it("keeps existing translation keys in sync, allowing only exact Task 11, Task 13B and Task 14B English-only copy", () => {
    // AGENTS.md currently forbids new es/ar copy. Preserve strict parity for
    // every pre-existing key; only the owner-approved Gmail, Task13B and exact Task14B keys are English-only.
    // Task13B mandate's 25 exact keys are separately enforced by StaffStandingMandatePanel.test.ts.
    const englishOnly = /^(?:GmailConnect\.[^.]+|GmailApprovalCard\.[^.]+|More\.gmailConnect|StaffApprovalCard\.agentic[A-Z][^.]*|StaffStandingMandate\.[^.]+)$/;
    const keys = (locale: string) => {
      const messages = localeMessages(locale);
      return Object.entries(messages)
        .flatMap(([namespace, values]) => Object.keys(values).map(key => `${namespace}.${key}`))
        .filter(key => !englishOnly.test(key) && !approvedTask14bSet.has(key))
        .sort();
    };
    expect(keys("es")).toEqual(keys("en"));
    expect(keys("ar")).toEqual(keys("en"));
  });

  it("requires every Task 14B purchasing key in en and forbids silently expanding the exception", () => {
    const en = localeMessages("en"), es = localeMessages("es"), ar = localeMessages("ar");
    for (const [namespace, allowedKeys] of Object.entries(approvedTask14bEnglishOnly)) {
      expect(Object.keys(en[namespace] ?? {}).sort(), namespace)
        .toEqual([...allowedKeys].sort());
      for (const key of allowedKeys) {
        expect(en[namespace]?.[key], namespace+"."+key).toEqual(expect.any(String));
        expect(en[namespace][key].trim().length).toBeGreaterThan(0);
      }
      expect(es[namespace]).toBeUndefined();
      expect(ar[namespace]).toBeUndefined();
    }
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

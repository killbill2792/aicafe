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

  it("keeps existing translation keys in sync while allowing only approved English-only domains", () => {
    // AGENTS.md forbids new es/ar copy. Keep strict parity for ALL pre-existing
    // keys; Task 11 Gmail and Task 16B work-status keys are the only exceptions.
    // This is an exact key allowlist, NOT a blanket SupervisorWork namespace skip.
    const englishOnly = /^(?:GmailConnect\.[^.]+|GmailApprovalCard\.[^.]+|More\.gmailConnect|SupervisorWork\.(?:heading|stale|more|effectReceipt|replyReceipt|status|copy))$/;
    const keys = (locale: string) => {
      const messages = localeMessages(locale);
      return Object.entries(messages)
        .flatMap(([namespace, values]) => Object.keys(values).map(key => `${namespace}.${key}`))
        .filter(key => !englishOnly.test(key))
        .sort();
    };
    expect(keys("es")).toEqual(keys("en"));
    expect(keys("ar")).toEqual(keys("en"));
  });

  it("requires complete English-only Task 16B status copy rather than hiding missing keys", () => {
    const work = localeMessages("en").SupervisorWork as unknown as {
      heading: string; stale: string; more: string; effectReceipt: string;
      replyReceipt: string; status: Record<string, string>; copy: Record<string, string>;
    };
    expect(Object.keys(work).sort()).toEqual([
      "heading", "stale", "more", "effectReceipt", "replyReceipt", "status", "copy"
    ].sort());
    expect(Object.keys(work.status).sort()).toEqual([
      "queued", "running", "retrying", "approval_required", "uncertain",
      "failed", "cancelled", "answer_ready", "verified_complete",
    ].sort());
    const requiredWorkCopyKeys = [
      "stepAuthorizeOwner",
      "stepOwnerTurn",
      "stepVerifyReport",
      "runTitle",
      "runAnswerReady",
      "runUncertain",
      "runFailed",
      "runQueued",
      "runGeneric",
      "runChecking",
      "runUncertainNext",
      "runFailedNext",
      "runAnswerNext",
      "runActiveNext",
      "jobTitle",
      "jobAnswerReady",
      "jobStale",
      "jobFailed",
      "jobRunning",
      "jobStaleNext",
      "jobFailedNext",
      "jobAnswerNext",
      "jobActiveNext",
      "proposalTitle",
      "proposalDraft",
      "proposalVerified",
      "proposalUncertain",
      "proposalCancelled",
      "proposalFailed",
      "proposalExecuting",
      "proposalDraftNext",
      "proposalVerifiedNext",
      "proposalUncertainNext",
      "proposalCancelledNext",
      "proposalFailedNext",
      "proposalExecutingNext"
    ];
    expect(Object.keys(work.copy).sort()).toEqual(requiredWorkCopyKeys.sort());
    for (const [key, value] of Object.entries(work.copy)) {
      expect(value, "SupervisorWork.copy." + key).toEqual(expect.any(String));
      expect(value.trim().length).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(work.status)) {
      expect(value, "SupervisorWork.status." + key).toEqual(expect.any(String));
      expect(value.trim().length).toBeGreaterThan(0);
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

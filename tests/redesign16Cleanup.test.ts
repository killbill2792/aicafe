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
const approvedTask14cEnglishOnly: Record<string, readonly string[]> = {
  "SupplierVendorCommunication": [
    "title",
    "intro",
    "supplier",
    "refresh",
    "channel",
    "gmail",
    "phone",
    "portal",
    "inPerson",
    "other",
    "email",
    "details",
    "verify",
    "revoke",
    "saved",
    "revoked",
    "error",
    "orders",
    "order",
    "outcome",
    "unknown",
    "notContacted",
    "contacted",
    "acknowledged",
    "accepted",
    "declined",
    "note",
    "saveOutcome",
    "outcomeSaved",
    "pending",
    "status",
    "poDraft",
    "poUncertain",
    "poSent",
    "poCannotVerify",
    "poOwnerNotice"
  ]
};
const approvedTask14cSet = new Set(Object.entries(approvedTask14cEnglishOnly)
  .flatMap(([namespace, keys]) => keys.map(key => namespace+"."+key)));
// Task16C adds English-only owner controls. Enumerate exact keys so the
// existing translation-parity guard still rejects every unexpected addition.
const approvedTask16cEnglishOnly = ["title","subtitle","publicWeb","publicWebHelp","fileRead","fileReadHelp","fileList","fileListHelp","fileRevoked","filePaused","fileAllowed","revokeFile","revokeConfirm","loadMore","computer","computerUnavailable","loading","loadFailed","saveFailed","refresh","on","off","changePending","noFiles","gmailIntro","fileAccessRevokedMessage","statusUnavailableMessage","ownerAccessRevokedMessage"];
const approvedTask16cSet = new Set(approvedTask16cEnglishOnly.map(key=>"SupervisorAccess."+key));
const approvedTask14bSet = new Set(Object.entries(approvedTask14bEnglishOnly)
  .flatMap(([namespace, keys]) => keys.map(key => namespace+"."+key)));

// Task16A: exact approved English-only namespace, pinned against accidental growth.
const approvedTask16aKeys = [
  "oneTimeTitle",
  "oneTimeEmpty",
  "oneTimeHelp",
  "title",
  "open",
  "close",
  "library",
  "routines",
  "permissions",
  "savedChats",
  "emptyChats",
  "routineTitle",
  "routineHelp",
  "emptyRoutines",
  "routineUnavailable",
  "permissionTitle",
  "permissionHelp",
  "emptyPermissions",
  "permissionUnavailable",
  "noThread",
  "goalName",
  "staffName",
  "unknownName",
  "active",
  "expired",
  "revoked",
  "superseded",
  "expires",
  "limit",
  "week",
  "status",
  "goalDaily",
  "staffRecipients",
  "newGoal",
  "reviseGoal",
  "chooseExpiry",
  "requestCode",
  "code",
  "verify",
  "challengeIssued",
  "challengeExpires",
  "challengeExpired",
  "phoneRequired",
  "factorUnavailable",
  "verifyFailed",
  "requestFailed",
  "grantConfirmed",
  "revoke",
  "revokeConfirmed",
  "revokeFailed",
  "refresh",
  "loading",
  "revokeBusy",
  "generalError",
  "ownerRequired",
  "revisionConflict",
  "staffGrant",
  "staffHelp",
  "notUnlimited",
] as const;
const approvedTask16aSet = new Set(approvedTask16aKeys.map(key => "SupervisorMandateCenter."+key));

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

  it("keeps existing translation keys in sync, allowing only exact Task 11, Task 13B, Task 14B and Task 16A English-only copy", () => {
    // AGENTS.md currently forbids new es/ar copy. Preserve strict parity for
    // every pre-existing key; only the owner-approved Gmail, Task13B and exact Task14B keys are English-only.
    // Task13B mandate's 25 exact keys are separately enforced by StaffStandingMandatePanel.test.ts.
    const englishOnly = /^(?:GmailConnect\.[^.]+|GmailApprovalCard\.[^.]+|More\.gmailConnect|StaffApprovalCard\.agentic[A-Z][^.]*|StaffStandingMandate\.[^.]+|SupervisorWork\.(?:heading|stale|more|effectReceipt|replyReceipt|status|copy))$/;
    const keys = (locale: string) => {
      const messages = localeMessages(locale);
      return Object.entries(messages)
        .flatMap(([namespace, values]) => Object.keys(values).map(key => `${namespace}.${key}`))
        .filter(key => !englishOnly.test(key) && !approvedTask14bSet.has(key)
          && !approvedTask14cSet.has(key) && !approvedTask16aSet.has(key) && !approvedTask16cSet.has(key))
        .sort();
    };
    expect(keys("es")).toEqual(keys("en"));
    expect(keys("ar")).toEqual(keys("en"));
  });

  it("pins every Task 16A owner permission label without weakening translation parity", () => {
    const en=localeMessages("en"),es=localeMessages("es"),ar=localeMessages("ar");
    const actual=en.SupervisorMandateCenter as Record<string,string> | undefined;
    expect(Object.keys(actual ?? {}).sort()).toEqual([...approvedTask16aKeys].sort());
    for(const key of approvedTask16aKeys){
      expect(actual?.[key],key).toEqual(expect.any(String));
      expect(actual?.[key].trim().length).toBeGreaterThan(0);
    }
    expect(es.SupervisorMandateCenter).toBeUndefined();
    expect(ar.SupervisorMandateCenter).toBeUndefined();
  });

  it("requires ONLY the exact English-only Task 14C vendor communication copy", () => {
    const en = localeMessages("en"), es = localeMessages("es"), ar = localeMessages("ar");
    for (const [namespace, allowedKeys] of Object.entries(approvedTask14cEnglishOnly)) {
      expect(Object.keys(en[namespace] ?? {}).sort(), namespace).toEqual([...allowedKeys].sort());
      for (const key of allowedKeys) {
        expect(en[namespace]?.[key], namespace+"."+key).toEqual(expect.any(String));
        expect(en[namespace][key].trim().length).toBeGreaterThan(0);
      }
      expect(es[namespace]).toBeUndefined();
      expect(ar[namespace]).toBeUndefined();
    }
  });
  it("requires exactly the authorized Task16C English keys without touching other locales",()=> {
    const english=localeMessages("en"), spanish=localeMessages("es"), arabic=localeMessages("ar");
    expect(Object.keys(english.SupervisorAccess??{}).sort()).toEqual([...approvedTask16cEnglishOnly].sort());
    expect(spanish.SupervisorAccess).toBeUndefined();
    expect(arabic.SupervisorAccess).toBeUndefined();
    for(const key of approvedTask16cEnglishOnly){
      expect(english.SupervisorAccess[key],key).toEqual(expect.any(String));
      expect(english.SupervisorAccess[key].trim().length,key).toBeGreaterThan(0);
    }
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
      "failed", "cancelled", "answer_ready", "verified_complete", "source_resolved",
    ].sort());
    const requiredWorkCopyKeys = [
      "stepAuthorizeOwner", "stepOwnerTurn", "stepVerifyReport", "runTitle", "runAnswerReady",
      "runUncertain", "runFailed", "runQueued", "runGeneric", "runChecking",
      "runUncertainNext", "runFailedNext", "runAnswerNext", "runActiveNext", "jobTitle",
      "jobAnswerReady", "jobStale", "jobFailed", "jobRunning", "jobStaleNext",
      "jobFailedNext", "jobAnswerNext", "jobActiveNext", "proposalTitle", "proposalDraft",
      "proposalVerified", "proposalUncertain", "proposalCancelled", "proposalFailed", "proposalExecuting",
      "proposalDraftNext", "proposalVerifiedNext", "proposalUncertainNext", "proposalCancelledNext", "proposalFailedNext",
      "proposalExecutingNext", "investigationTitle", "investigationQueued", "investigationRunning", "investigationRetrying",
      "investigationWatching", "investigationUncertain", "investigationFailed", "investigationResolved", "investigationNext",
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

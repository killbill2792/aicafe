import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const page=readFileSync(new URL("../../app/[locale]/staff/page.tsx",import.meta.url),"utf8");
const panel=readFileSync(new URL("./StaffStandingMandatePanel.tsx",import.meta.url),"utf8");
const english=JSON.parse(readFileSync(new URL("../../messages/en.json",import.meta.url),"utf8")) as {
 StaffStandingMandate:Record<string,string>;
};

/** The real Staff page owns navigation. A key based on both verified café and
 * week makes React destroy the previous week's pending OTP/code before any
 * new week's button is usable; API alone cannot know the selected UI week. */
describe("Task13B owner MFA challenge isolation and English-only panel",()=>{
 it("remounts the whole OTP state when either the selected café or week changes",()=>{
  expect(page).toMatch(/StaffStandingMandatePanel key=\{.*scope\.businessId.*selected.*\}/);
  expect(page).toContain("week={selected} businessId={scope.businessId}");
  expect(panel).toContain('const [challenge,setChallenge]=useState<Challenge|null>(null)');
  expect(panel).toContain('const [code,setCode]=useState("")');
  expect(panel).toContain("response.mandate.staff_week_start!==week");
 });
 it("keeps every owner-facing MFA status, explanation, and button in messages/en.json",()=>{
  const keys=[
   "loading","phoneFactorRequired","conversationRequired","authorityVerified",
   "authorityMissing","verificationUnavailable","challengeRequesting",
   "challengeInstructions","challengeRejected","grantConfirmed","grantRejected",
   "revokeConfirmed","revokeRejected","regionLabel","title","weekOf",
   "scopeDescription","activeStart","activeEnd","revokeButton","phoneCode",
   "verifyButton","maxEmployees","challengeButton","providerNotice",
  ];
  expect(Object.keys(english.StaffStandingMandate).sort()).toEqual(keys.sort());
  for(const key of keys){
   expect(english.StaffStandingMandate[key]).toEqual(expect.any(String));
   expect(english.StaffStandingMandate[key].trim().length).toBeGreaterThan(3);
   expect(panel).toContain("copy."+key);
  }
  expect(panel).toContain('import english from "@/messages/en.json"');
  expect(panel).not.toMatch(/setMessage\("/);
 });
});

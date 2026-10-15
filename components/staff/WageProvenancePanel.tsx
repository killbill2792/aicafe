"use client";

import { useRef,useState,useTransition } from "react";
import { stableCreateRequestKey, type PendingCreate } from "@/lib/scheduling/idempotencyClient";
import { useRouter } from "@/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { saveSchedulingFoundationRecord } from "@/lib/actions/schedulingFoundation";
import { type SchedulingRow, schedulingFieldClass as field,
  schedulingPrimaryClass as primary } from "./AvailabilityEditor";
import type { EmployeeRow } from "@/lib/data/getEmployees";

type CashState = "unknown" | "known_paid" | "salary_conversion_pending" | "known_eligible_zero";

export default function WageProvenancePanel({ employee, records }: {
  employee: EmployeeRow; records:SchedulingRow[];
}) {
  const t=useTranslations("SchedulingAvailability"), staff=useTranslations("ManageStaff");
  const locale=useLocale(), router=useRouter();
  const existing=records.find(r=>r.employee_id===employee.id);
  const [savedRecord,setSavedRecord]=useState<{id:string;revision:number}|null>(
    existing ? {id:existing.id,revision:existing.revision} : null);
  // Keep our submitted revision for CAS: newer props may belong to another owner.
  const currentRecord = savedRecord;
  const [status,setStatus]=useState<CashState>((existing?.cash_cost_state as CashState)??"unknown");
  const [evidence,setEvidence]=useState(String(existing?.eligibility_reference??""));
  const [pending,run]=useTransition(),[error,setError]=useState(""),[saved,setSaved]=useState(false);
  const retry=useRef<PendingCreate>(null);
  const [conflicted,setConflicted]=useState(false);
  function submit(){
    if(conflicted){setError(t("conflict"));return;}
    if(status==="known_eligible_zero" && evidence.trim().length<8){
      setError(t("eligibilityEvidenceRequired"));return;
    }
    const payload={employee_id:employee.id,cash_cost_state:status,
      eligibility_reference:status==="known_eligible_zero"?evidence.trim():null};
    run(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"compensation",action:currentRecord?"update":"create",
        ...(currentRecord?{id:currentRecord.id,expectedRevision:currentRecord.revision}:
          {requestKey:stableCreateRequestKey(retry,payload)}),
        data:payload,
      });
      if(!result.ok){
        if(result.error==="conflict_or_missing"){setConflicted(true);router.refresh();}
        setError(t(result.error==="conflict_or_missing"?"conflict":"compensationCannotVerify"));return;
      }
      retry.current=null;setSavedRecord({id:result.id,revision:result.revision});
      setSaved(true);setError("");router.refresh();
    });
  }
  const verified = (existing?.cash_cost_state as CashState|undefined)??"unknown";
  const wageIsKnown = employee.wageAmountCents!==null || employee.defaultHourlyWageCents!==null;
  const wagePeriod=employee.wagePeriod==="hour" ? staff("wagePeriodHour")
    : employee.wagePeriod==="month" ? staff("wagePeriodMonth") : staff("wagePeriodYear");
  return <section className="flex flex-col gap-3 rounded-xl bg-white p-3">
    <h4 className="text-[17px] font-bold">{t("wageProvenance")}</h4>
    <p className="text-[17px] text-ink-muted">{t("wageExplanation")}</p>
    <p className="font-semibold">{t("recordedWage")}: {
      wageIsKnown
        ? new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(
          (employee.wageAmountCents??employee.defaultHourlyWageCents??0)/100)
        : t("wageUnknown")
    } {wageIsKnown&&`/ ${wagePeriod}`}</p>
    <p className="text-[17px] font-semibold">{t("currentEvidence")}: {t(verified)}</p>
    {existing?.eligibility_verified_at != null && <p className="text-[17px] text-ink-muted">
      {t("confirmedAt")}: {String(existing.eligibility_verified_at)}
    </p>}
    {conflicted && <button type="button" className={primary} onClick={()=>{
      setSavedRecord(existing ? {id:existing.id,revision:existing.revision} : null);
      setConflicted(false);setError("");retry.current=null;
    }}>{t("applyAfterConflict")}</button>}
    <fieldset disabled={pending || conflicted} aria-busy={pending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
    <label className="flex flex-col gap-1 text-[17px]">{t("cashState")}
      <select className={field} value={status} onChange={e=>{setStatus(e.target.value as CashState);setSaved(false);}}>
        {(["unknown","known_paid","salary_conversion_pending","known_eligible_zero"] as CashState[]).map(s=>
          <option value={s} key={s}>{t(s)}</option>)}
      </select>
    </label>
    {status==="known_eligible_zero" && <label className="flex flex-col gap-1 text-[17px]">
      {t("eligibilityEvidenceRequired")}
      <textarea className="min-h-24 rounded-xl border border-line p-3 text-[17px]" value={evidence}
        onChange={e=>setEvidence(e.target.value)} maxLength={240}/>
    </label>}
    <p className="text-[17px] text-ink-muted">{t("notLegalAdvice")}</p>
    <button type="button" className={primary} disabled={pending} onClick={submit}>{t("saveEvidence")}</button>
    {error && <p role="alert" className="text-[17px] text-warn">{error}</p>}
    {saved && <p role="status" className="text-[17px] text-good">{t("saved")}</p>}
    </fieldset>
  </section>;
}

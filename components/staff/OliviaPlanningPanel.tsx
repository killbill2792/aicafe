"use client";

import { useRef, useState, useTransition } from "react";
import { stableCreateRequestKey, type PendingCreate } from "@/lib/scheduling/idempotencyClient";
import { useLocale, useTranslations } from "next-intl";
import { previewOliviaWeek, saveOliviaWeekDraft, readOliviaPlanHistory,
  readOliviaPlanRevision, saveOliviaWeekEdit } from "@/lib/actions/oliviaPlanning";
import OliviaShiftEditor from "./OliviaShiftEditor";
import OliviaPublicationPanel from "./OliviaPublicationPanel";
import OliviaRuleReviewPanel from "./OliviaRuleReviewPanel";
import type { PlannerResult, PlannerScenario, PlannerShift } from "@/lib/calc/scheduling/plannerTypes";
import type { OliviaNotice, OliviaBlocker } from "@/lib/scheduling/planInput.server";

function mondayOf(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function nextMonday(date: string) {
  const monday = new Date(mondayOf(date) + "T12:00:00Z");
  if (Number.isNaN(monday.getTime())) return date;
  monday.setUTCDate(monday.getUTCDate() + 7);
  return monday.toISOString().slice(0, 10);
}

function localShiftTime(value: string, timezone: string, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium", timeStyle: "short", timeZone: timezone,
    }).format(new Date(value));
  } catch { return value; }
}

/** Owner-facing proposal workspace only. No approval or publishing controls
 * until backend can independently revalidate and transactionally commit.
 */
export default function OliviaPlanningPanel({ today, currency, publicationEnabled=false }: { today: string; currency: string | null; publicationEnabled?: boolean }) {
  const t = useTranslations("OliviaPlanning");
  const locale = useLocale();
  const cashLabel=(cents:number|null)=>{
    if(cents===null||!currency)return t("unknown");
    try{return new Intl.NumberFormat(locale,{style:"currency",currency}).format(cents/100);}
    catch{return t("unknown");}
  };
  const [week, setWeek] = useState(() => nextMonday(today));
  const [result, setResult] = useState<PlannerResult | null>(null);
  const [notices, setNotices] = useState<OliviaNotice[]>([]);
  const [employees, setEmployees] = useState<Record<string,string>>({});
  const [locations, setLocations] = useState<Record<string,string>>({});
  const [locationNames, setLocationNames] = useState<Record<string,string>>({});
  const [sourceDigest, setSourceDigest] = useState<string | null>(null);
  const [frozenShiftKeys,setFrozenShiftKeys]=useState<string[]>([]);
  const retry = useRef<PendingCreate>(null);
  const proposalHead = useRef<number|null>(null);
  const [objective, setObjective] = useState<PlannerScenario["objective"]>("balanced");
  const [currentRevision, setCurrentRevision] = useState(0);
  const [publishedRevision, setPublishedRevision] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<{ revision: number; status: string; id:string }>>([]);
  const [editing, setEditing] = useState<{revision:number;id:string;objective:PlannerScenario["objective"]}|null>(null);
  const [editedShifts, setEditedShifts] = useState<PlannerShift[]>([]);
  const [inspected, setInspected] = useState<{
    revision: number; status: string; shifts: PlannerShift[]
  }|null>(null);
  const editRetry = useRef<PendingCreate>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  const scenario = result?.scenarios.find(s => s.objective === objective);
  const revisionLabel=(status:string)=>t(({
    draft:"revisionDraft",approved:"revisionApproved",
    published:"revisionPublished",superseded:"revisionSuperseded",
  } as Record<string,string>)[status]??"revisionUnknown");
  const noticeKeys: Record<OliviaNotice["code"], string> = {
    wage_unknown:"noticeWage", availability_missing:"noticeAvailability",
    unconfirmed_absence:"noticeLeave", coverage_unconfirmed:"noticeCoverage",
    no_active_staff:"noticeNoStaff", limits_missing:"noticeLimits",
    legacy_schedules:"noticeLegacy", policy_unverified:"noticePolicy",
    source_provisional:"noticeProvisional",
  };
  const blockerKeys: Record<OliviaBlocker["code"], string> = {
    no_location:"blockerLocation", no_coverage:"blockerCoverage",
    conflicting_limits:"blockerLimits",
  };

  function loadHistory(selectedWeek: string) {
    return readOliviaPlanHistory({ week: selectedWeek }).then(r => {
      if (r.ok) {
        setCurrentRevision(r.currentRevision);
        if (proposalHead.current !== null && proposalHead.current !== r.currentRevision) {
          setSourceDigest(null);
          setError(t("revisionConflict"));
        }
        setPublishedRevision(r.publishedRevision);
        setHistory(r.revisions);
      } else {
        setError(t(r.error==="unauthorized"?"ownerRequired":
          r.error==="disabled"?"previewDisabled":"historyUnavailable"));
      }
    });
  }

  function preview() {
    setError(""); setNotice(""); setResult(null); setSourceDigest(null);
    setNotices([]); setFrozenShiftKeys([]);
    retry.current = null;
    proposalHead.current = null;
    startTransition(async () => {
      const selectedWeek = week;
      const response = await previewOliviaWeek({ week: selectedWeek });
      if (!response.ok) {
        setError(response.blockers?.length ? response.blockers.map(b =>
          t(blockerKeys[b.code], { employee: b.employeeName ?? "" })).join(" ") :
          t(({invalid_input:"previewInvalid",invalid_week:"previewInvalid",
            unauthorized:"ownerRequired",disabled:"previewDisabled",
            storage_unavailable:"previewUnavailable",
            planner_unavailable:"previewUnavailable"} as Record<string,string>)[response.error]??
            "previewUnavailable"));
        return;
      }
      setResult(response.plan);
      proposalHead.current=response.previewRevision;
      setObjective(response.plan.scenarios.find(s=>s.objective!=="owner_time")
        ?.objective ?? "balanced");
      setNotices(response.notices);
      setEmployees(response.employees); setLocations(response.locations);
      setLocationNames(response.locationNames);
      setFrozenShiftKeys(response.frozenShiftKeys);
      setSourceDigest(response.sourceDigest);
      await loadHistory(selectedWeek);
    });
  }
  function save() {
    if (!sourceDigest || !scenario || proposalHead.current === null) {
      setError(t("previewRequired")); return;
    }
    if (proposalHead.current !== currentRevision) {
      setError(t("revisionConflict")); return;
    }
    setError(""); setNotice("");
    const intent = { week, objective, expectedRevision: proposalHead.current,
      expectedSourceDigest: sourceDigest };
    const requestKey = stableCreateRequestKey(retry, intent);
    startTransition(async () => {
      try {
        const response = await saveOliviaWeekDraft({ ...intent, requestKey });
        if (!response.ok) {
          setError(response.error === "source_changed" ? t("sourceChanged") :
            response.error === "conflict" ? t("revisionConflict") :
            response.error === "capacity_exceeded" ? t("capacityExceeded") :
            response.error === "missing_inputs" ? t("missingInputs") :
            t("saveFailed"));
          return;
        }
        retry.current = null;
        proposalHead.current = null;
        setResult(null);
        setNotice(t("savedRevision", { revision: response.revision }));
        await loadHistory(week);
      } catch {
        // Retain request identity for retry after a network timeout.
        setError(t("saveFailed"));
      }
    });
  }

  function inspectRevision(revisionId:string) {
    setError("");
    startTransition(async()=>{
      try {
        const response=await readOliviaPlanRevision({week,revisionId});
        if(!response.ok){setError(t("editLoadFailed"));return;}
        setInspected({revision:response.revision,status:response.status,
          shifts:response.scenario.shifts});
      } catch {setError(t("editLoadFailed"));}
    });
  }
  function startEditing(revisionId:string) {
    if(!sourceDigest){setError(t("previewRequired"));return;}
    setError("");setNotice("");
    startTransition(async()=>{
      try {
        const response=await readOliviaPlanRevision({week,revisionId});
        if(!response.ok){setError(t("editLoadFailed"));return;}
        if(response.revision!==response.currentRevision){
          setError(t("revisionConflict"));return;
        }
        if(response.sourceDigest!==sourceDigest){
          setError(t("sourceChanged"));return;
        }
        setEditing({revision:response.revision,id:revisionId,
          objective:response.scenario.objective});
        setEditedShifts(response.scenario.shifts.map(s=>({...s,
          breaks:s.breaks.map(b=>({...b}))})));
        editRetry.current=null;
      } catch {setError(t("editLoadFailed"));}
    });
  }
  function saveEdit() {
    if(!editing || !sourceDigest){setError(t("previewRequired"));return;}
    const intent={horizonStart:week,expectedRevision:editing.revision,
      baseRevisionId:editing.id,objective:editing.objective,
      expectedSourceDigest:sourceDigest,shifts:editedShifts};
    const requestKey=stableCreateRequestKey(editRetry,intent);
    setError("");setNotice("");
    startTransition(async()=>{
      try {
        const response=await saveOliviaWeekEdit({...intent,requestKey});
        if(!response.ok){
          // Never show raw validation codes, employee IDs or UTC instants
          // to an owner. The server remains authoritative for all validation.
          const reasons:Record<string,string>={
            outside_confirmed_availability:"editAvailability",
            overlap_rest_or_hour_cap_violation:"editHours",
            pinned_commitment_removed:"editPinned",
            pinned_shift_changed:"editPinned",
            unrecorded_paid_rest_break:"editBreaks",
            unverified_paid_rest_break:"editBreaks",
            invalid_unpaid_break:"editBreaks",
            meal_shorter_than_configured_minimum:"editBreaks",
            paid_minutes_mismatch:"editBreaks",
            handoff_overlap_missing:"editCoverage",
            coverage_matching_budget_exhausted:"editCoverage",
            invalid_shift_interval:"editTime",
            shift_outside_seven_day_horizon:"editTime",
          };
          const violations=("violations" in response && Array.isArray(response.violations))
            ? response.violations : [];
          const details=[...new Set(violations.map((v:string)=>
            t(reasons[v.split(":")[0]]??"editInvalidGeneric")))].slice(0,4);
          setError(response.error==="invalid_shifts" ?
            (details.length?details.join(" "):t("editInvalidGeneric")) :
            response.error==="source_changed" ? t("sourceChanged") :
            response.error==="revision_conflict" ? t("revisionConflict") : t("saveFailed"));
          return;
        }
        editRetry.current=null;setEditing(null);setEditedShifts([]);
        setNotice(t("savedRevision",{revision:response.revision}));
        await loadHistory(week);
      } catch {setError(t("saveFailed"));}
    });
  }
  return <section className="flex flex-col gap-4 rounded-card-lg bg-card p-[18px]"
    aria-label={t("title")}>
    <div>
      <h2 className="text-lg font-bold">{t("title")}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t("draftOnly")}</p>
    </div>
    <label className="flex flex-col gap-1 text-base font-semibold">
      {t("week")}
      <input type="date" value={week} disabled={pending} onChange={e => {
        setWeek(mondayOf(e.target.value)); setResult(null); setHistory([]);
        setCurrentRevision(0); setPublishedRevision(null); setError(""); setNotice("");
        setSourceDigest(null); setFrozenShiftKeys([]); retry.current = null; setNotices([]);
        proposalHead.current=null;
        setEditing(null); setEditedShifts([]); editRetry.current=null;
        setInspected(null);
      }} className="h-12 rounded-xl border border-line bg-paper px-3" />
    </label>
    <button type="button" disabled={pending} onClick={preview}
      className="min-h-12 rounded-full bg-ink px-4 font-bold text-paper disabled:opacity-50">
      {t("generate")}
    </button>
    {error && <p role="alert" className="text-base text-warn">{error}</p>}
    {notice && <p role="status" className="text-base">{notice}</p>}
    {result && <>
      <p className="text-sm text-ink-muted">{t("status")}: {t(result.status)}</p>
      <label className="flex flex-col gap-1 font-semibold">{t("scenario")}
        <select value={objective} onChange={e =>
          setObjective(e.target.value as PlannerScenario["objective"])}
          className="min-h-12 rounded-xl border border-line bg-paper px-3">
          {result.scenarios.filter(s=>s.objective!=="owner_time").map(s=>
            <option key={s.objective} value={s.objective}>
              {t(s.objective==="cash"?"cash":"balanced")}
            </option>)}
        </select>
      </label>
      {scenario && <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-line p-3 text-sm">
          <p>{t("coverage")}: {scenario.completeCoverage ? t("complete") : t("incomplete")}</p>
          <p>{t("ownerMinutes")}: {t("unknown")}</p>
          <p>{t("ownerUnavailable")}</p>
          <p>{t("cashCost")}: {cashLabel(scenario.cost.cashWagesCents)}</p>
          <p>{t("legalReview")}: {scenario.legalReview === "verified_profile" ?
            t("verified") : t("unverified")}</p>
        </div>
        <h3 className="font-bold">{t("assignments")}</h3>
        {scenario.shifts.length === 0 && <p>{t("noAssignments")}</p>}
        {scenario.shifts.map((shift, i) => <div key={i}
          className="rounded-xl border border-line px-3 py-2 text-sm">
          <p className="font-semibold">{employees[shift.employeeId] ?? shift.employeeId}</p>
          <p>{localShiftTime(shift.startAt, locations[shift.locationId] ?? "UTC", locale)} — {localShiftTime(shift.endAt, locations[shift.locationId] ?? "UTC", locale)}</p>
          <p>{t("location")}: {locationNames[shift.locationId] ?? shift.locationId}</p>
          <p>{t("paidMinutes")}: {shift.paidMinutes}</p>
        </div>)}
        <h3 className="font-bold">{t("gaps")}</h3>
        {scenario.gaps.length === 0 && <p>{t("noGaps")}</p>}
        {scenario.gaps.map((gap, i) => <p key={i} className="text-sm text-warn">
          {localShiftTime(gap.startAt, locations[gap.locationId] ?? "UTC", locale)} — {localShiftTime(gap.endAt, locations[gap.locationId] ?? "UTC", locale)}: {t(({
            no_active_staff:"gapNoStaff",qualification_missing:"gapQualification",
            no_confirmed_availability:"gapAvailability",capacity_or_overlap:"gapCapacity",
            break_or_rest_constraint:"gapRest",daily_hour_limit:"gapDaily",
            weekly_hour_limit:"gapWeekly",date_specific_cap:"gapDateCap",
            pinned_conflict:"gapPinned",solver_budget:"gapSolver",
            handoff_overlap_missing:"gapHandoff",
          } as Record<string,string>)[gap.reason]??"gapUnknown")} ({gap.missingHeadcount})
        </p>)}
        {!scenario.completeCoverage && <p className="text-sm text-warn">{t("partialDraftUnavailable")}</p>}
        <button type="button" disabled={pending || !sourceDigest || !scenario.hardConstraintsSatisfied || !scenario.completeCoverage}
          onClick={save}
          className="min-h-12 rounded-full border border-ink px-4 font-bold disabled:opacity-50">
          {t("saveDraft")}
        </button>
      </div>}
    </>}
    {notices.length > 0 && <div role="status" className="text-sm text-ink-muted">
      <h3 className="font-bold">{t("warnings")}</h3>
      <ul className="list-disc space-y-1 ps-5">{notices.map((notice, i) =>
        <li key={i}>{t(noticeKeys[notice.code], { employee: notice.employeeName ?? "" })}</li>)}</ul>
    </div>}
    <div className="border-t border-line pt-3">
      <button type="button" onClick={() => startTransition(() => { void loadHistory(week); })}
        disabled={pending} className="min-h-12 font-semibold underline">
        {t("refreshHistory")}
      </button>
      <p className="text-sm">{t("officialVersion")}: {publishedRevision ?? t("none")}</p>
      {history.map(item => <div key={item.revision}
        className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
        <span>V{item.revision} · {revisionLabel(item.status)}</span>
        <button type="button" className="min-h-12 px-3 underline"
          disabled={pending}
          onClick={()=>inspectRevision(item.id)}>{t("viewRevision")}</button>
        {item.revision===currentRevision &&
          <button type="button" className="min-h-12 px-3 underline"
            disabled={pending || !sourceDigest}
            onClick={()=>startEditing(item.id)}>{t("editRevision")}</button>}
      </div>)}
      {inspected && <section aria-label={t("viewRevision")}
        className="rounded-xl border border-line p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>{t("reviewVersion",{revision:inspected.revision})} · {revisionLabel(inspected.status)}</strong>
          <button type="button" className="min-h-12 underline"
            onClick={()=>setInspected(null)}>{t("closeRevision")}</button>
        </div>
        {inspected.shifts.length===0 && <p>{t("noAssignments")}</p>}
        {inspected.shifts.map((shift,i)=><div key={i}
          className="border-t border-line py-2">
          <strong>{employees[shift.employeeId]??shift.employeeId}</strong>
          <p>{localShiftTime(shift.startAt,locations[shift.locationId]??"UTC",locale)}
          {" — "}{localShiftTime(shift.endAt,locations[shift.locationId]??"UTC",locale)}</p>
          <p>{locationNames[shift.locationId]??shift.locationId}</p>
        </div>)}
        <p className="text-ink-muted">{t("historicalPlanOnly")}</p>
      </section>}
      {editing && <>
        <p role="status">{t("editingRevision",{revision:editing.revision})}</p>
        <OliviaShiftEditor shifts={editedShifts} onChange={setEditedShifts}
          employees={employees} locations={locations} names={locationNames}
          week={week} disabled={pending} frozenShiftKeys={frozenShiftKeys}/>
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={pending} onClick={saveEdit}
            className="min-h-12 rounded-full bg-ink px-4 font-bold text-paper disabled:opacity-50">
            {t("saveEditedDraft")}
          </button>
          <button type="button" disabled={pending}
            className="min-h-12 rounded-full border border-line px-4"
            onClick={()=>{setEditing(null);setEditedShifts([]);editRetry.current=null;}}>
            {t("cancelEdit")}
          </button>
        </div>
      </>}
    </div>
    <OliviaRuleReviewPanel key={week} week={week} onChanged={()=>loadHistory(week)}/>
    <OliviaPublicationPanel key={week} week={week}
      latest={history.find(item=>item.revision===currentRevision)??null}
      publishedRevision={publishedRevision} enabled={publicationEnabled}
      employees={employees} locations={locations} names={locationNames}
      onChanged={()=>loadHistory(week)}/>
  </section>;
}

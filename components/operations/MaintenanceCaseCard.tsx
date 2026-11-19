"use client";

import {useState,type FormEvent} from "react";
import {useRouter} from "next/navigation";
import {assignMaintenanceWork,recordMaintenanceProgress,reportMaintenanceCase} from "@/lib/actions/maintenance";

type Copy=Record<string,string>;
type CaseProps={taskId:string;equipmentLabel:string;stage:string;symptom:string};
type Props={copy:Copy;caseData?:CaseProps;staff?:{id:string;name:string}[]};

const stages:Record<string,string>={
  reported:"stageReported",investigating:"stageInvestigating",
  awaiting_owner:"stageAwaiting",assigned:"stageAssigned",
  request_sent:"stageSent",repair_claimed:"stageClaimed",
  verified_repaired:"stageVerified",blocked:"stageBlocked",
  reopened:"stageReopened",
};

/** A thin view over the same operating_tasks row as Supervisor/Home. */
export default function MaintenanceCaseCard({copy,caseData,staff}:Props){
  const router=useRouter();
  const [equipmentLabel,setEquipmentLabel]=useState("");
  const [symptom,setSymptom]=useState("");
  const [severity,setSeverity]=useState<"critical"|"high"|"normal"|"unknown">("unknown");
  const [note,setNote]=useState("");
  const [employee,setEmployee]=useState("");
  const [assignment,setAssignment]=useState("");
  const [assignmentNonce,setAssignmentNonce]=useState("");
  const [nonce,setNonce]=useState("");
  const [reportedAt,setReportedAt]=useState("");
  const [pendingKind,setPendingKind]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  async function report(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    if(busy)return;
    setBusy(true);setMessage("");
    const current=nonce||crypto.randomUUID();
    const observed=reportedAt||new Date().toISOString();
    setNonce(current);setReportedAt(observed);
    try{
      const result=await reportMaintenanceCase({nonce:current,equipmentLabel,symptom,severity,
        observedAt:observed});
      if(!result.ok){setMessage(copy.reportError);return;}
      setNonce("");setReportedAt("");setEquipmentLabel("");setSymptom("");setSeverity("unknown");
      setMessage(copy.reportSaved);router.refresh();
    }catch{setMessage(copy.reportError);}
    finally{setBusy(false);}
  }
  async function progress(kind:"repair_claim"|"operational_verification"|"blocked"|"reopened"|"follow_up"){
    if(!caseData||busy)return;
    setBusy(true);setMessage("");
    const current=pendingKind===kind&&nonce?nonce:crypto.randomUUID();
    setNonce(current);setPendingKind(kind);
    try{
      const result=await recordMaintenanceProgress({
        taskId:caseData.taskId,nonce:current,kind,
        note,workingConfirmed:kind==="operational_verification",
      });
      if(!result.ok){setMessage(copy.updateError);return;}
      setNonce("");setPendingKind(null);setNote("");setMessage(copy.updateSaved);router.refresh();
    }catch{setMessage(copy.updateError);}
    finally{setBusy(false);}
  }

  async function assign(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    if(!caseData||busy||!employee||!assignment.trim())return;
    const key=assignmentNonce||crypto.randomUUID();setAssignmentNonce(key);
    setBusy(true);setMessage("");
    try{
      const result=await assignMaintenanceWork({taskId:caseData.taskId,employeeId:employee,
        nonce:key,prompt:assignment});
      if(!result.ok){setMessage(copy.updateError);return;}
      setAssignmentNonce("");setAssignment("");setEmployee("");
      setMessage("Assignment saved in the employee's private inbox. Repair is not verified.");
      router.refresh();
    }catch{setMessage(copy.updateError);}
    finally{setBusy(false);}
  }

  if(!caseData)return <section className="rounded-2xl border border-line bg-card p-4" aria-label={copy.heading}>
    <h2 className="text-lg font-bold text-ink">{copy.heading}</h2>
    <p className="mt-1 text-sm text-ink-muted">{copy.intro}</p>
    <form onSubmit={report} className="mt-3 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">{copy.equipment}
        <input value={equipmentLabel} onChange={e=>{setEquipmentLabel(e.target.value);setNonce("");setReportedAt("");}}
          maxLength={120} required disabled={busy} className="min-h-12 rounded-xl border border-line bg-paper px-3"/>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">{copy.problem}
        <textarea value={symptom} onChange={e=>{setSymptom(e.target.value);setNonce("");setReportedAt("");}}
          maxLength={1200} required disabled={busy} rows={3}
          className="rounded-xl border border-line bg-paper p-3"/>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">{copy.severity}
        <select value={severity} onChange={e=>{setSeverity(e.target.value as typeof severity);setNonce("");setReportedAt("");}}
          disabled={busy} className="min-h-12 rounded-xl border border-line bg-paper px-3">
          <option value="unknown">{copy.unknown}</option><option value="normal">{copy.normal}</option>
          <option value="high">{copy.high}</option><option value="critical">{copy.critical}</option>
        </select>
      </label>
      <button type="submit" disabled={busy}
        className="min-h-12 rounded-full bg-accent px-4 font-bold text-on-accent disabled:opacity-50">
        {busy?copy.submitting:copy.submit}
      </button>
    </form>
    <p className="mt-2 text-sm text-ink-muted">{copy.notSent}</p>
    {message&&<p role="status" className="mt-2 font-semibold text-ink">{message}</p>}
  </section>;

  const stage=caseData.stage;
  return <section className="mt-3 rounded-xl border border-line bg-card p-3" aria-label={copy.caseTitle}>
    <h3 className="font-bold text-ink">{copy.caseTitle}: {caseData.equipmentLabel}</h3>
    <p className="mt-1 text-sm text-ink-muted">{copy.stage}: {copy[stages[stage]??"stageReported"]}</p>
    {caseData.symptom&&<p className="mt-2 text-sm text-ink" dir="auto">{caseData.symptom}</p>}
    {stage!=="verified_repaired"&&
      <label className="mt-3 flex flex-col gap-1 text-sm font-semibold text-ink">{copy.note}
        <textarea value={note} onChange={e=>{setNote(e.target.value);setNonce("");}}
          rows={2} maxLength={1200} disabled={busy} className="rounded-xl border border-line bg-paper p-3"/>
      </label>}
    <div className="mt-3 flex flex-wrap gap-2">
      {stage!=="verified_repaired"&&stage!=="repair_claimed"&&stage!=="blocked"&&
        <button type="button" disabled={busy||!note.trim()} onClick={()=>progress("repair_claim")}
          className="min-h-12 rounded-full border border-ink px-3 font-semibold disabled:opacity-50">
          {copy.repairClaim}</button>}
      {stage==="repair_claimed"&&
        <button type="button" disabled={busy} onClick={()=>progress("operational_verification")}
          className="min-h-12 rounded-full border border-ink px-3 font-semibold disabled:opacity-50">
          {copy.verifyWorking}</button>}
      {stage!=="verified_repaired"&&stage!=="blocked"&&
        <button type="button" disabled={busy||!note.trim()} onClick={()=>progress("blocked")}
          className="min-h-12 rounded-full border border-line px-3 font-semibold disabled:opacity-50">
          {copy.block}</button>}
      {(stage==="blocked"||stage==="verified_repaired")&&
        <button type="button" disabled={busy} onClick={()=>progress("reopened")}
          className="min-h-12 rounded-full border border-line px-3 font-semibold disabled:opacity-50">
          {copy.reopen}</button>}
      {stage!=="verified_repaired"&&stage!=="blocked"&&
        <button type="button" disabled={busy||!note.trim()} onClick={()=>progress("follow_up")}
          className="min-h-12 rounded-full border border-line px-3 font-semibold disabled:opacity-50">
          {copy.followUp}</button>}
    </div>
    {stage!=="verified_repaired"&&<form onSubmit={assign} className="mt-3 space-y-2 border-t border-line pt-3">
      <p className="font-semibold">Assign maintenance work</p>
      {staff===undefined?<p className="text-sm">Staff access could not be verified.</p>:staff.length===0?
        <p className="text-sm">No linked active staff. Link an employee in Staff first.</p>:<>
        <label className="block text-sm">Employee
          <select value={employee} onChange={e=>{setEmployee(e.target.value);setAssignmentNonce("");}} disabled={busy}
            className="block w-full rounded-xl border border-line p-2" required>
            <option value="">Choose employee</option>{staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">Exact work to assign
          <textarea value={assignment} onChange={e=>{setAssignment(e.target.value);setAssignmentNonce("");}}
           disabled={busy} required maxLength={1200} className="block w-full rounded-xl border border-line p-2"/>
        </label>
        <button type="submit" disabled={busy||!employee||!assignment.trim()}
          className="min-h-12 rounded-full border border-ink px-3 font-semibold disabled:opacity-50">
          Approve and assign work
        </button>
      </>}
    </form>}
    {stage==="repair_claimed"&&<p className="mt-2 text-sm text-ink-muted">{copy.verifyHelp}</p>}
    {stage!=="verified_repaired"&&<p className="mt-2 text-sm text-ink-muted">{copy.notSent}</p>}
    {message&&<p role="status" className="mt-2 text-sm font-semibold text-ink">{message}</p>}
  </section>;
}

"use client";

import {useRef,useState,useTransition} from "react";
import {useTranslations} from "next-intl";
import {readOliviaLaborRuleContext,saveOliviaLaborRuleReview}
  from "@/lib/actions/oliviaPlanning";
import {stableCreateRequestKey,type PendingCreate}
  from "@/lib/scheduling/idempotencyClient";

type Named={id:string;name:string};
const integer=(value:string)=>Number(value);

export default function OliviaRuleReviewPanel({week,onChanged}:{
  week:string;onChanged:()=>Promise<void>;
}){
  const t=useTranslations("OliviaPlanning");
  const [pending,start]=useTransition();
  const [ready,setReady]=useState(false);
  const [reviewRevision,setReviewRevision]=useState(0);
  const [locations,setLocations]=useState<Named[]>([]);
  const [employees,setEmployees]=useState<Named[]>([]);
  const [jurisdiction,setJurisdiction]=useState<Record<string,string>>({});
  const [classification,setClassification]=useState<Record<string,string>>({});
  const [source,setSource]=useState("");
  const [limits,setLimits]=useState({
    maxContinuousWorkMinutes:"360",unpaidMealMinutes:"30",
    paidRestMinutes:"0",minRestBetweenShiftsMinutes:"600",
    dailyAfterMinutes:"480",weeklyAfterMinutes:"2400",
    multiplierNumerator:"3",multiplierDenominator:"2",
  });
  const [attested,setAttested]=useState(false);
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const retry=useRef<PendingCreate>(null);
  function load(){
    setError("");setNotice("");
    start(async()=>{
      try{
        const r=await readOliviaLaborRuleContext({week});
        if(!r.ok){setError(t("ruleLoadError"));return;}
        setReady(true);setReviewRevision(r.reviewRevision);
        setLocations(r.locations);setEmployees(r.employees);
        const profile=r.profile as Record<string,unknown>|null;
        const jurisdictions=profile?.jurisdictionByLocationId;
        const classes=profile?.classificationByEmployeeId;
        setJurisdiction((jurisdictions&&typeof jurisdictions==="object")?
          jurisdictions as Record<string,string>:{});
        setClassification((classes&&typeof classes==="object")?
          classes as Record<string,string>:{});
        setSource(typeof profile?.source==="string"?profile.source:"");
        setAttested(false);
        retry.current=null;
      }catch{setError(t("ruleLoadError"));}
    });
  }
  function save(){
    if(!ready||!attested){setError(t("ruleAttestRequired"));return;}
    const profile={
      verified:true as const,source,
      jurisdictionByLocationId:Object.fromEntries(locations.map(loc=>[
        loc.id,jurisdiction[loc.id]??""])),
      classificationByEmployeeId:Object.fromEntries(employees.map(e=>[
        e.id,classification[e.id]??""])),
      maxContinuousWorkMinutes:integer(limits.maxContinuousWorkMinutes),
      unpaidMealMinutes:integer(limits.unpaidMealMinutes),
      paidRestMinutes:integer(limits.paidRestMinutes),
      minRestBetweenShiftsMinutes:integer(limits.minRestBetweenShiftsMinutes),
      overtime:{verified:true as const,dailyAfterMinutes:integer(limits.dailyAfterMinutes),
        weeklyAfterMinutes:integer(limits.weeklyAfterMinutes),
        multiplierNumerator:integer(limits.multiplierNumerator),
        multiplierDenominator:integer(limits.multiplierDenominator)},
    };
    const intent={expectedRevision:reviewRevision,attestation:true as const,profile};
    const requestKey=stableCreateRequestKey(retry,intent);
    setError("");setNotice("");
    start(async()=>{
      try{
        const result=await saveOliviaLaborRuleReview({week,
          review:{...intent,requestKey}});
        if(!result.ok){setError(t("ruleSaveError"));return;}
        retry.current=null;setAttested(false);setReviewRevision(result.revision);
        setNotice(t("ruleReviewSaved",{revision:result.revision}));
        await onChanged();
      }catch{setError(t("ruleSaveError"));}
    });
  }
  const ruleFields=[
    ["maxContinuousWorkMinutes","ruleContinuous"],["unpaidMealMinutes","ruleMeal"],
    ["paidRestMinutes","rulePaidRest"],["minRestBetweenShiftsMinutes","ruleShiftRest"],
    ["dailyAfterMinutes","ruleOvertimeDaily"],["weeklyAfterMinutes","ruleOvertimeWeekly"],
    ["multiplierNumerator","ruleMultiplierNumerator"],
    ["multiplierDenominator","ruleMultiplierDenominator"],
  ] as const;
  return <details className="rounded-xl border border-line p-3">
    <summary className="min-h-12 cursor-pointer font-bold">{t("ruleReviewTitle")}</summary>
    <p className="mt-2 text-sm text-ink-muted">{t("ruleReviewCaution")}</p>
    <button type="button" disabled={pending} onClick={load}
      className="my-3 min-h-12 underline font-semibold">{t("loadRules")}</button>
    {ready&&<div className="flex flex-col gap-3">
      <p className="text-sm">{t("ruleReviewVersion")}: {reviewRevision}</p>
      <label className="flex flex-col gap-1">{t("ruleSource")}
        <textarea value={source} disabled={pending}
          onChange={e=>setSource(e.target.value)} rows={3}
          className="rounded-lg border border-line bg-card p-3"/>
      </label>
      {locations.map(loc=><label key={loc.id} className="flex flex-col gap-1">
        {t("ruleJurisdiction",{name:loc.name})}
        <input type="text" value={jurisdiction[loc.id]??""}
          disabled={pending} onChange={e=>setJurisdiction(prev=>({
            ...prev,[loc.id]:e.target.value}))}
          className="min-h-12 rounded-lg border border-line bg-card px-3"/>
      </label>)}
      {employees.map(e=><label key={e.id} className="flex flex-col gap-1">
        {t("ruleClassification",{name:e.name})}
        <input type="text" value={classification[e.id]??""}
          disabled={pending} onChange={ev=>setClassification(prev=>({
            ...prev,[e.id]:ev.target.value}))}
          className="min-h-12 rounded-lg border border-line bg-card px-3"/>
      </label>)}
      {ruleFields.map(([key,label])=><label key={key} className="flex flex-col gap-1">
        {t(label)}
        <input type="number" min="0" value={limits[key]}
          disabled={pending} onChange={e=>setLimits(prev=>({
            ...prev,[key]:e.target.value}))}
          className="min-h-12 rounded-lg border border-line bg-card px-3"/>
      </label>)}
      <label className="flex items-start gap-3">
        <input type="checkbox" checked={attested} disabled={pending}
          onChange={e=>setAttested(e.target.checked)} className="mt-1 size-5"/>
        <span>{t("ruleAttestation")}</span>
      </label>
      <button type="button" disabled={pending||!attested}
        onClick={save}
        className="min-h-12 rounded-full border border-ink px-4 font-semibold disabled:opacity-50">
        {t("saveRuleReview")}
      </button>
    </div>}
    {error&&<p role="alert" className="text-sm text-warn">{error}</p>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
  </details>;
}

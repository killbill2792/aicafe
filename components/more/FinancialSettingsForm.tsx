"use client";
import {useState,useTransition} from "react";
import {saveSupervisorFinancialSettings} from "@/lib/actions/supervisorFinancialSettings";
type Labels={ingredient:string;ingredientHint:string;monthlyPayroll:string;monthlyPayrollHint:string;
 save:string;saving:string;saved:string;failed:string;none:string};
export default function FinancialSettingsForm({initialIngredientRate,initialOwnerPayroll,labels}:{
 initialIngredientRate:number|null;initialOwnerPayroll:number|null;labels:Labels
}){
 const [ingredient,setIngredient]=useState(initialIngredientRate===null?"":(initialIngredientRate*100).toString());
 const [payroll,setPayroll]=useState(initialOwnerPayroll===null?"":(initialOwnerPayroll/100).toFixed(2));
 const [state,setState]=useState<"idle"|"saved"|"error">("idle");
 const [pending,startTransition]=useTransition();
 const submit=()=>{
  const percent=ingredient.trim()===""?null:Number(ingredient);
  const dollars=payroll.trim()===""?null:Number(payroll);
  if(percent!==null&&(!Number.isFinite(percent)||percent<0||percent>=100)||
    dollars!==null&&(!Number.isFinite(dollars)||dollars<0||
      !/^\\d+(?:\\.\\d{1,2})?$/.test(payroll.trim()))){
   setState("error");return;
  }
  startTransition(async()=>{
   const result=await saveSupervisorFinancialSettings({
    ingredientPercent:percent,ownerMonthlyPayrollExtrasCents:dollars===null?null:Math.round(dollars*100)
   });
   setState(result.ok?"saved":"error");
  });
 };
 return <div className="flex flex-col gap-5">
  <label className="flex flex-col gap-2 text-[17px] font-semibold text-ink">
   {labels.ingredient}
   <input type="number" inputMode="decimal" min="0" max="99.99" step="0.01"
    value={ingredient} placeholder={labels.none}
    onChange={e=>{setIngredient(e.target.value);setState("idle");}}
    className="min-h-12 rounded-xl border border-line bg-card p-3" />
   <span className="text-[15px] font-normal text-ink-muted">{labels.ingredientHint}</span>
  </label>
  <label className="flex flex-col gap-2 text-[17px] font-semibold text-ink">
   {labels.monthlyPayroll}
   <input type="number" inputMode="decimal" min="0" step="0.01"
    value={payroll} placeholder={labels.none}
    onChange={e=>{setPayroll(e.target.value);setState("idle");}}
    className="min-h-12 rounded-xl border border-line bg-card p-3" />
   <span className="text-[15px] font-normal text-ink-muted">{labels.monthlyPayrollHint}</span>
  </label>
  <button type="button" onClick={submit} disabled={pending}
   className="min-h-12 rounded-xl bg-accent px-4 text-[17px] font-semibold text-white">
    {pending?labels.saving:labels.save}
  </button>
  {state==="saved"&&<p role="status" className="text-good">{labels.saved}</p>}
  {state==="error"&&<p role="alert" className="text-neg">{labels.failed}</p>}
 </div>;
}

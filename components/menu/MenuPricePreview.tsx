"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { formatCents } from "@/lib/calc";
import { menuPricePreview } from "@/lib/calc/menuPricePreview";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";

/** Transparent, owner-confirmable WHAT-IF. This does not overwrite receipts,
 * payroll, POS or the saved menu price. Confirmed values last only until
 * this screen is refreshed; no claim that they are durable records. */
type Fields = { running:string;payroll:string;drinks:string;fee:string };
const dollars=(n:number|null)=>n===null?"":(n/100).toFixed(2);
const pct=(n:number|null)=>n===null?"":(n/100).toFixed(2);
function cents(raw:string):number|null{
  const s=raw.trim();
  if(!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(s))return null;
  const n=Math.round(Number(s)*100);
  return Number.isSafeInteger(n)&&n<=100_000_000_000?n:null;
}
function drinks(raw:string):number|null{
  const s=raw.trim();
  if(!/^[1-9][0-9]{0,7}$/.test(s))return null;
  const n=Number(s);return Number.isSafeInteger(n)?n:null;
}
function feeBps(raw:string):number|null{
  const s=raw.trim();
  if(!/^(?:[0-9]{1,2}|100)(?:\.[0-9]{1,2})?$/.test(s))return null;
  const n=Math.round(Number(s)*100);
  return n>=0&&n<=10000?n:null;
}
export default function MenuPricePreview({item}:{item:MenuControlItem}){
  const t=useTranslations("Menu");
  const basis=item.pricingBasis;
  const initial:Fields={
    running:dollars(basis?.monthlyRunningCents??null),
    payroll:dollars(basis?.monthlyPayrollCents??null),
    drinks:basis?.monthlyDrinks===null||basis?.monthlyDrinks===undefined?"":String(basis.monthlyDrinks),
    fee:pct(basis?.processingFeeBps??null),
  };
  const [draft,setDraft]=useState<Fields>(initial);
  const [confirmed,setConfirmed]=useState<{
    monthlyRunningCents:number|null;monthlyPayrollCents:number|null;
    monthlyDrinks:number|null;processingFeeBps:number|null;
  }|null>(null);
  const [error,setError]=useState(false);
  if(!basis)return null;
  const values=confirmed??{
    monthlyRunningCents:basis.monthlyRunningCents,
    monthlyPayrollCents:basis.monthlyPayrollCents,
    monthlyDrinks:basis.monthlyDrinks,
    processingFeeBps:basis.processingFeeBps,
  };
  const estimate=menuPricePreview({
    priceCents:item.priceCents,
    ingredientCents:item.costStatus==="READY"?item.ingredientsCostCents:null,
    monthlyRunningCents:values.monthlyRunningCents,
    monthlyPayrollCents:values.monthlyPayrollCents,
    monthlyDrinks:values.monthlyDrinks,
    monthlyPrepSeconds:basis.monthlyPrepSeconds,
    itemPrepSeconds:item.prepSeconds,
    processingFeeBps:values.processingFeeBps,
    targetOperatingMarginBps:basis.targetOperatingMarginBps,
  });
  function confirm(){
    const running=draft.running.trim()===""?null:cents(draft.running);
    const payroll=draft.payroll.trim()===""?null:cents(draft.payroll);
    const volume=draft.drinks.trim()===""?null:drinks(draft.drinks);
    const fee=draft.fee.trim()===""?null:feeBps(draft.fee);
    if((draft.running.trim()!==""&&running===null)||
       (draft.payroll.trim()!==""&&payroll===null)||
       (draft.drinks.trim()!==""&&volume===null)||
       (draft.fee.trim()!==""&&fee===null)){setError(true);return;}
    setConfirmed({monthlyRunningCents:running,monthlyPayrollCents:payroll,
      monthlyDrinks:volume,processingFeeBps:fee});
    setError(false);
  }
  const input=(field:keyof Fields,label:string,source:string,unit:"usd"|"count"|"percent")=>(
    <label className="block rounded-xl bg-card p-3">
      <span className="block text-[17px] font-bold text-ink">{label}</span>
      <span className="mt-1 block text-sm text-ink-muted">{source}</span>
      <span className="mt-2 flex min-h-12 items-center rounded-lg border border-line bg-paper px-3">
        {unit==="usd"&&<span className="me-1 font-bold" aria-hidden="true">$</span>}
        <input className="w-full min-w-0 bg-transparent text-[17px] text-ink outline-none"
          aria-label={label} inputMode={unit==="count"?"numeric":"decimal"}
          placeholder={t("priceBasisMissing")} value={draft[field]}
          onChange={e=>{setDraft(v=>({...v,[field]:e.target.value}));setError(false)}}/>
        {unit==="percent"&&<span className="ms-2 font-bold" aria-hidden="true">%</span>}
      </span>
    </label>
  );
  const status=(key:"recorded"|"estimated"|"missing"|"projected"|"actual")=>
    t(key==="recorded"||key==="actual"?"priceBasisSaved":
      key==="projected"?"priceBasisProjected":
      key==="estimated"?"priceBasisEstimated":"priceBasisNotAvailable");
  const money=(n:number|null)=>n===null?t("priceBasisMissing"):formatCents(n);
  const period=basis.oldestDate&&basis.latestDate?t("priceBasisWindow",{
    from:basis.oldestDate,to:basis.latestDate,days:basis.coveredDays,
  }):t("priceBasisNoHistory");
  return <details className="mt-3 rounded-2xl border border-line bg-paper p-3.5">
    <summary className="min-h-12 cursor-pointer text-[17px] font-extrabold text-ink">
      {t("priceBasisTitle")}
    </summary>
    <p className="mb-3 text-[17px] leading-snug text-ink-muted">{t("priceBasisHelp")}</p>
    <div className="rounded-xl border border-line/60 bg-card p-3">
      <p className="text-sm font-bold text-ink-muted">{t("priceBasisHistoryTitle")}</p>
      <p className="mt-1 text-[17px] text-ink">{period}</p>
      <p className="mt-1 text-sm text-ink-muted">{t("priceBasisHistoryCaveat")}</p>
    </div>
    <div className="mt-3 grid gap-2 md:grid-cols-2">
      {input("running",t("priceBasisBills"),status(basis.runningStatus),"usd")}
      {input("payroll",t("priceBasisPayroll"),status(basis.payrollStatus),"usd")}
      {input("drinks",t("priceBasisDrinks"),status(basis.volumeStatus),"count")}
      {input("fee",t("priceBasisFees"),status(basis.feeStatus),"percent")}
    </div>
    <p className="mt-3 text-sm text-ink-muted">{t("priceBasisAvoidDoubleCount")}</p>
    {error&&<p role="alert" className="mt-2 text-[17px] text-warn">{t("priceBasisInvalid")}</p>}
    <button type="button" onClick={confirm}
      className="mt-3 min-h-12 rounded-full bg-ink px-5 text-[17px] font-bold text-paper">
      {t("priceBasisConfirm")}
    </button>
    <p className="mt-2 text-sm text-ink-muted">{confirmed?t("priceBasisPreviewConfirmed"):t("priceBasisPreviewOnly")}</p>
    <div className="mt-3 rounded-xl border border-line/70 bg-card p-3">
      <p className="text-[17px] font-extrabold text-ink">{t("priceBasisResultTitle")}</p>
      <dl className="mt-2 space-y-2 text-[17px]">
        <div className="flex justify-between gap-3"><dt>{t("sellingPrice")}</dt><dd className="font-bold">{formatCents(item.priceCents)}</dd></div>
        <div className="flex justify-between gap-3"><dt>{t("costToMake")}</dt><dd>{money(item.costStatus==="READY"?item.ingredientsCostCents:null)}</dd></div>
        <div className="flex justify-between gap-3"><dt>{t("priceBasisPayrollPerDrink")}</dt><dd>{money(estimate.laborPerDrinkCents)}</dd></div>
        <div className="flex justify-between gap-3"><dt>{t("priceBasisBillsPerDrink")}</dt><dd>{money(estimate.billsPerDrinkCents)}</dd></div>
        <div className="flex justify-between gap-3"><dt>{t("priceBasisFeePerDrink")}</dt><dd>{money(estimate.cardFeePerDrinkCents)}</dd></div>
        <div className="flex justify-between gap-3 border-t border-line pt-2 font-extrabold"><dt>{t("priceBasisProfit")}</dt><dd>{money(estimate.allocatedProfitCents)}</dd></div>
      </dl>
      {estimate.status==="missing"
        ?<p className="mt-3 text-[17px] text-warn">{t("priceBasisIncomplete")}</p>
        :<><p className="mt-3 text-[17px] font-bold">{t("priceBasisTarget",{
          margin:(basis.targetOperatingMarginBps/100).toFixed(1),
          price:money(estimate.targetPriceCents),
        })}</p>
          <p className="mt-2 text-sm text-ink-muted">{estimate.laborAllocation==="equal_drinks"?
            t("priceBasisEqualAllocation"):t("priceBasisPrepAllocation")}</p></>}
      <p className="mt-2 text-sm leading-snug text-ink-muted">{t("priceBasisDisclaimer")}</p>
    </div>
  </details>;
}

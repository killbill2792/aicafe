"use client";
import {useState,useTransition} from "react";
import {useTranslations} from "next-intl";
import {Plus,Minus,X} from "lucide-react";
import {useRouter} from "@/i18n/navigation";
import {createMenuCombo} from "@/lib/actions/menuCombo";
import {calculateComboTotals,suggestComboPrices} from "@/lib/calc/menuCombo";
import {formatCents} from "@/lib/calc";
export type ComboChoice={id:string;name:string;sizeLabel:string|null;priceCents:number;costCents:number|null;estimated:boolean;menuGroup:string|null};
type Line={itemId:string;quantity:number;buyInCostCents:number|null};
export default function MenuComboBuilder({choices}:{choices:ComboChoice[]}){
 const t=useTranslations("MenuBuilder"),router=useRouter();
 const [name,setName]=useState(""),[price,setPrice]=useState(0),[lines,setLines]=useState<Line[]>([]),[next,setNext]=useState(""),[error,setError]=useState("");
 const [pending,start]=useTransition();
 const selected=lines.map(line=>({line,item:choices.find(choice=>choice.id===line.itemId)!})).filter(x=>x.item);
 const totals=price>0?calculateComboTotals(selected.map(({line,item})=>({quantity:line.quantity,priceCents:item.priceCents,costCents:line.buyInCostCents??item.costCents})),price):null;
 const fullPrice=selected.reduce((sum,{line,item})=>sum+line.quantity*item.priceCents,0);
 const suggested=suggestComboPrices(fullPrice);
 const fmt=(key:string,vals:Record<string,string|number>)=>Object.entries(vals).reduce((v,[k,x])=>v.replaceAll("{"+k+"}",String(x)),t.raw(key) as string);
 function addLine(){if(!next||lines.some(l=>l.itemId===next))return;setLines(prev=>[...prev,{itemId:next,quantity:1,buyInCostCents:null}]);setNext("");}
 function setBuyIn(id:string,value:string){const parsed=Math.round(Number(value)*100);if(value.trim()!==""&&(!Number.isSafeInteger(parsed)||parsed<=0))return;setLines(prev=>prev.map(l=>l.itemId===id?{...l,buyInCostCents:value.trim()===""?null:parsed}:l));}
 function setQty(id:string,delta:number){setLines(prev=>prev.map(l=>l.itemId===id?{...l,quantity:Math.max(1,Math.min(100,l.quantity+delta))}:l));}
 function save(){setError("");start(async()=>{const result=await createMenuCombo({name:name.trim(),priceCents:price,items:lines});if(result.ok)router.push(`/menu/${result.id}`);else setError(result.error);});}
 return <div className="mx-auto w-full max-w-2xl space-y-4 text-ink">
 <label className="block text-[15px] font-bold text-ink-muted">{t("comboName")}<input value={name} onChange={e=>setName(e.target.value)} className="mt-2 min-h-12 w-full rounded-2xl border border-line bg-card px-4 text-[17px]" placeholder={t("comboName")}/></label>
 <div><h2 className="mb-2 font-headline text-lg font-extrabold">{t("whatsInside")}</h2>
 <div className="divide-y divide-line rounded-2xl border border-line bg-card">
 {selected.map(({line,item})=><div key={item.id} className="flex min-h-20 items-center gap-3 p-3">
 <span className="flex size-11 items-center justify-center rounded-xl bg-paper">{item.menuGroup==="Bakery"?"🥐":"☕"}</span>
 <div className="min-w-0 flex-1"><p className="font-bold">{item.name}</p><p className="text-[13px] text-ink-muted">{line.buyInCostCents!==null?fmt("boughtAt",{amount:formatCents(line.buyInCostCents)}):item.costCents===null?t("unknown"):`${t("cost")} ${formatCents(item.costCents)}`}{item.estimated?" · "+t("estimate"):""}</p>
 {item.costCents===null&&<label className="mt-1 flex items-center gap-2 text-[13px] text-ink-muted">{t("buyInCost")} $<input type="number" min=".01" step=".01" inputMode="decimal" value={line.buyInCostCents===null?"":(line.buyInCostCents/100).toFixed(2)} onChange={e=>setBuyIn(item.id,e.target.value)} className="min-h-10 w-20 rounded-lg border border-line bg-card px-2"/></label>}
 <div className="mt-1 flex items-center"><button type="button" onClick={()=>setQty(item.id,-1)} className="flex size-10 items-center justify-center rounded-lg bg-paper" aria-label="Decrease quantity"><Minus size={15}/></button><span className="min-w-9 text-center font-bold">{line.quantity}</span><button type="button" onClick={()=>setQty(item.id,1)} className="flex size-10 items-center justify-center rounded-lg bg-paper" aria-label="Increase quantity"><Plus size={15}/></button></div>
 </div><span className="shrink-0 font-bold">{formatCents(item.priceCents)}</span><button type="button" onClick={()=>setLines(prev=>prev.filter(l=>l.itemId!==item.id))} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-paper" aria-label={t("remove")}><X size={16}/></button>
 </div>)}
 {!selected.length&&<p className="p-4 text-ink-muted">{t("addItem")}</p>}
 </div><div className="mt-3 flex flex-wrap gap-2"><select aria-label={t("addItem")} value={next} onChange={e=>setNext(e.target.value)} className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-card px-3"><option value="">{t("addItem")}</option>{choices.filter(item=>item.menuGroup!=="Combos"&&!lines.some(l=>l.itemId===item.id)).map(item=><option key={item.id} value={item.id}>{item.name} · {formatCents(item.priceCents)}</option>)}</select><button type="button" disabled={!next} onClick={addLine} className="min-h-12 rounded-xl border-2 border-dashed border-accent px-4 font-bold text-accent-text">+ {t("addItem")}</button></div></div>
 <label className="block font-bold">{t("comboPrice")}<div className="mt-2 flex min-h-20 items-center gap-2 rounded-2xl border-2 border-accent bg-card px-3"><span className="text-3xl font-extrabold">{price>0?formatCents(price):"—"}</span><div className="ms-auto flex gap-2"><button type="button" onClick={()=>setPrice(x=>Math.max(0,x-25))} aria-label="Lower combo price" className="flex size-12 items-center justify-center rounded-xl bg-paper text-accent-text"><Minus/></button><button type="button" onClick={()=>setPrice(x=>x+25)} aria-label="Raise combo price" className="flex size-12 items-center justify-center rounded-xl bg-paper text-accent-text"><Plus/></button></div></div></label>
 <div className="flex flex-wrap gap-2">{suggested.map(value=><button type="button" key={value} onClick={()=>setPrice(value)} className={`min-h-10 rounded-full border px-3 font-semibold ${value===price?"border-accent bg-accent-soft text-accent-text":"border-line bg-card"}`}>{formatCents(value)}</button>)}</div>
 {totals&&<><div className="space-y-2 rounded-2xl bg-paper p-4"><div className="flex justify-between"><span>{t("soldSeparately")}</span><b>{formatCents(totals.soldSeparatelyCents)}</b></div><div className="flex justify-between"><span>{t("comboPrice")}</span><b>{formatCents(totals.comboPriceCents)}</b></div><div className="flex justify-between font-bold"><span>{totals.savesCustomerCents>=0?t("savesCustomer"):t("customerPaysMore")}</span><b className="text-accent-text">{formatCents(totals.savesCustomerCents)}</b></div></div>
 <div className="rounded-2xl border border-line bg-card p-4"><div className="flex justify-between"><span>{t("yourCost")}</span><b>{totals.costCents===null?t("unknown"):formatCents(totals.costCents)}</b></div><div className="mt-2 flex justify-between font-extrabold text-good"><span>{t("keep",{amount:"",percent:0}).split(" ")[0]}</span><span>{totals.keepCents===null?t("unknown"):`${formatCents(totals.keepCents)} (${totals.keepPercent}%)`}</span></div><p className="mt-2 text-[13px] text-ink-muted">{t("separateNote")}: {totals.separateKeepCents===null?t("unknown"):formatCents(totals.separateKeepCents)}</p></div></>}
 {error&&<p role="alert" className="text-warn">{error}</p>}
 <button type="button" onClick={save} disabled={pending||!name.trim()||price<=0||lines.length<2} className="min-h-14 w-full rounded-2xl bg-accent text-lg font-bold text-on-accent disabled:opacity-50">{t("save")} {t("combo")}</button>
 </div>;
}

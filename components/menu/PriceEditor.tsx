"use client";
import { useState, useTransition } from "react";
import { updateMenuItemPrice } from "@/lib/actions/menuItems";
import { formatCents } from "@/lib/calc";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { getItemPricingStatus } from "@/lib/viewmodels/menuCatalogViewModel";
import { useRouter } from "@/i18n/navigation";

export default function PriceEditor({ item, labels, onCancel }: { item: MenuControlItem; labels: Record<"title"|"size"|"current"|"suggested"|"price"|"save"|"cancel", string>; onCancel: () => void }) {
 const router=useRouter(); const [value,setValue]=useState((item.priceCents/100).toFixed(2)); const [pending,start]=useTransition(); const [error,setError]=useState<string|null>(null); const status=getItemPricingStatus(item);
 return <section className="rounded-card-lg border border-line bg-card p-[18px]"><h2 className="text-xl font-bold">{labels.title}</h2><dl className="mt-3 grid gap-2 text-[17px]"><div className="flex justify-between"><dt className="text-ink-muted">{labels.size}</dt><dd className="font-bold">{item.sizeLabel??item.name}</dd></div><div className="flex justify-between"><dt className="text-ink-muted">{labels.current}</dt><dd>{formatCents(item.priceCents)}</dd></div>{(status.kind==="low"||status.kind==="high")&&<div className="flex justify-between"><dt className="text-ink-muted">{labels.suggested}</dt><dd className="font-bold">{formatCents(status.suggestedPriceCents)}</dd></div>}</dl><label className="mt-3 flex flex-col gap-1 font-semibold">{labels.price}<input className="h-12 rounded-lg border border-line px-3" inputMode="decimal" value={value} onChange={e=>setValue(e.target.value)}/></label>{error&&<p className="mt-2 text-sm text-warn">{error}</p>}<div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={onCancel} className="min-h-12 rounded-full border border-line font-bold">{labels.cancel}</button><button type="button" disabled={pending} onClick={()=>start(async()=>{const cents=Math.round(Number(value)*100);const result=await updateMenuItemPrice({menuItemId:item.id,priceCents:cents});if(result.ok){onCancel();router.refresh();}else setError(result.error);})} className="min-h-12 rounded-full bg-ink font-bold text-paper disabled:opacity-40">{labels.save}</button></div></section>;
}

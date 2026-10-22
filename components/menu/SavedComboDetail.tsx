import {getTranslations} from "next-intl/server";
import {calculateComboTotals} from "@/lib/calc/menuCombo";
import {formatCents} from "@/lib/calc";
import type {MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import type {SavedComboPart} from "@/lib/actions/getMenuComboComponents";
export default async function SavedComboDetail({name,priceCents,parts,items}:{name:string;priceCents:number;parts:SavedComboPart[];items:MenuItemForEdit[]}){
 const t=await getTranslations("MenuBuilder");
 const lookup=new Map(items.map(i=>[i.id,i]));
 const rows=parts.map(p=>({part:p,item:lookup.get(p.componentItemId)}));
 const unknown=rows.some(r=>!r.item);
 const totals=!unknown?calculateComboTotals(rows.map(({part,item})=>({
  quantity:part.quantity,priceCents:item!.priceCents,costCents:part.buyInCostCents??item!.ingredientsCostCents
 })),priceCents):null;
 return <section className="mx-auto w-full max-w-2xl space-y-5 text-ink">
 <h1 className="font-headline text-3xl font-extrabold">{name}</h1>
 <h2 className="font-headline text-xl font-bold">{t("whatsInside")}</h2>
 <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">{rows.map(({part,item})=><div key={part.componentItemId} className="flex min-h-20 items-center gap-3 p-4"><span className="flex size-12 items-center justify-center rounded-xl bg-paper">☕</span><div className="min-w-0 flex-1"><p className="font-bold">{item?.name??t("unknown")}</p><p className="text-sm text-ink-muted">{part.quantity} × {part.buyInCostCents!==null?t("boughtAt",{amount:formatCents(part.buyInCostCents)}):item?.ingredientsCostCents===null?t("unknown"):`${t("cost")} ${formatCents(item?.ingredientsCostCents??0)}`}</p></div><b>{item?formatCents(item.priceCents*part.quantity):"—"}</b></div>)}</div>
 {totals&&<><div className="space-y-2 rounded-2xl bg-paper p-4">
 <div className="flex justify-between"><span>{t("soldSeparately")}</span><b>{formatCents(totals.soldSeparatelyCents)}</b></div>
 <div className="flex justify-between"><span>{t("comboPrice")}</span><b>{formatCents(totals.comboPriceCents)}</b></div>
 <div className="flex justify-between text-accent-text"><b>{totals.savesCustomerCents>=0?t("savesCustomer"):t("customerPaysMore")}</b><b>{formatCents(Math.abs(totals.savesCustomerCents))}</b></div></div>
 <div className="rounded-2xl border border-line bg-card p-4">
 <div className="flex justify-between"><span>{t("yourCost")}</span><b>{totals.costCents===null?t("unknown"):formatCents(totals.costCents)}</b></div>
 <div className="mt-2 flex justify-between text-xl font-extrabold text-good"><span>{t("whatYouKeep")}</span><span>{totals.keepCents===null?t("unknown"):`${formatCents(totals.keepCents)} (${totals.keepPercent}%)`}</span></div>
 <p className="mt-3 text-sm text-ink-muted">{t("separateNote")}: {totals.separateKeepCents===null?t("unknown"):`${formatCents(totals.separateKeepCents)} (${totals.separateKeepPercent}%)`}</p>
 </div></>}
 </section>;
}

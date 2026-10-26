import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import {readUsageBusinessDate, readUsageVariance} from "@/lib/data/usageVariance.server";
import { listPantry } from "@/lib/actions/pantry";
import {usageWeekEnding} from "@/lib/calc/usageDates";
import { PANTRY_STARTERS } from "@/lib/menu/pantryStarter";
import {readPurchaseMonth} from "@/lib/data/inventory.server";
import {readModifierSetup} from "@/lib/data/modifierLinks.server";
import InventoryModifierPanel from "@/components/menu/InventoryModifierPanel";
import {readPendingInventoryProposals} from "@/lib/data/inventoryProposals.server";
import SupervisorProposalCard from "@/components/home/SupervisorProposalCard";
import InventoryPurchasePanel from "@/components/menu/InventoryPurchasePanel";
import {getLocale} from "next-intl/server";
import PageShell from "@/components/shared/PageShell";
import PantryWorkspace from "@/components/menu/PantryWorkspace";

export const dynamic = "force-dynamic";
export default async function PantryPage({searchParams}:{searchParams:Promise<{from?:string;to?:string;month?:string;proposals?:string}>}) {
  await requireOwnBusiness();
  const businessToday=await readUsageBusinessDate();
  const params=await searchParams;
  const valid=(d:string|undefined)=>!!d&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+"T00:00:00Z"));
  const to=valid(params.to)?params.to!:businessToday;
  const start=usageWeekEnding(to).from;
  const month=params.month&&/^\d{4}-(0[1-9]|1[0-2])$/.test(params.month)?params.month:businessToday.slice(0,7);
  const selectedIds=(params.proposals??"").split(",").filter(id=>/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id)).slice(0,100);
  const from=valid(params.from)&&params.from!<=to&&(Date.parse(to)-Date.parse(params.from!))/86400000<=30?params.from!:start; const [items,t,variance,purchases,inventoryText,locale,modifierSetup,pendingProposals]=await Promise.all([
    listPantry(),getTranslations("MenuBuilder"),readUsageVariance({from,to,groupBy:"shift"}).catch(()=>null),
    readPurchaseMonth(month).catch(()=>null),getTranslations("Inventory"),getLocale(),
    readModifierSetup().catch(()=>null),readPendingInventoryProposals(selectedIds).catch(()=>null)
  ]);
  const selected=selectedIds.flatMap(id=>pendingProposals?.find(p=>p.id===id)?[pendingProposals.find(p=>p.id===id)!]:[]);
  const orderedProposals=selectedIds.length?selected:pendingProposals;
  const i18nKeys=["title","heading","month","photo","unavailable","empty","totals","bulk","csv","chooseFile",
    "date","item","quantity","unit","cost","optional","edit","void","save","cancel","remove","addLine",
    "saveAll","none","import","failed","invalidCost","invalidQuantity","unknown","csvFailed","csvSaved","csvPartial",
    "source_manual","source_bulk","source_receipt_page","source_receipt_chat","source_chat_text",
    "source_csv","source_quickbooks","source_bank_feed","source_other",
    "modifierHeading","modifierExplain","modifierUnavailable","modifierEmpty",
    "modifierSuggested","modifierRecipe","modifierChoose","modifierConfirm",
    "modifierCreate","modifierIngredient","modifierBaseQuantity","modifierReplaces","modifierNoReplacement",
    "modifierLinked","modifierStale",
    "proposalsHeading","proposalsUnavailable"];
  const inventoryLabels=Object.fromEntries(i18nKeys.map(key=>[key,inventoryText.raw(key as never) as string]));

  return <PageShell className="px-4 pb-24 pt-6" wide>
    {selectedIds.length>0&&selected.length===0&&<p role="status" className="mb-4 text-[17px]">{inventoryLabels.proposalsUnavailable}</p>}
    {selectedIds.length>0&&selected.length>0&&<section className="mb-5 space-y-3">
      <h2 className="text-xl font-bold">{inventoryLabels.proposalsHeading}</h2>
      {selected.map(p=><SupervisorProposalCard key={p.id} threadId={p.threadId} proposalId={p.id} locale={locale as "en"|"es"|"ar"}/>)}
    </section>}
    <PantryWorkspace businessToday={businessToday} inventoryPanel={
      <InventoryPurchasePanel items={items.map(i=>({id:i.id,name:i.name,baseUnit:i.baseUnit}))}
        month={month} rows={purchases?.rows??[]} currency={purchases?.currency??"USD"}
        locale={locale as "en"|"es"|"ar"} t={inventoryLabels} today={businessToday} unavailable={!purchases}/>
    } variance={variance} items={items} starters={PANTRY_STARTERS.map(({key,name,category,baseUnit,packQuantity,packUnit})=>({key,name,category,baseUnit,packQuantity,packUnit}))}
      labels={Object.fromEntries(["title","search","all","coffee","milk","syrups","packaging","bakery","other","reviewNow","confirmed","add","packSize","packPrice","category","baseUnit","name","create","save","cancel","edit","estimate","confirm","usedIn","perUnit","priceUnknown","starterPack","chooseStarter","newIngredient","noItems","priceTitle","purchaseUnit","error","usageTitle","usagePeriod","usageExpected","usageActual","usageDifference","usageUnknown","usage_on_target","usage_watch","usage_over","usageMissing","usageRecord","usage_count","usage_purchase","usageIngredient","usageQuantity","usageUnit","usageDate","usageSaved","usageCountNote","usageShifts","usageExpectedOnly","usageStart","usageEnd","usageApply","usageStartCount","usageEndCount","usageCoverage","usageRecipeMissing","usageUnavailable","usageConnectToast","usageErrorInvalidQuantity","usageErrorInvalidUnit","usageErrorIngredientNotFound","usageErrorSaveFailed"].map(key=>[key,key==="title"?inventoryLabels.title:t.raw(key as never) as string]))} />
    {pendingProposals===null?<p role="alert" className="text-[17px]">{inventoryLabels.proposalsUnavailable}</p>:
      selectedIds.length===0&&orderedProposals&&orderedProposals.length>0&&<section className="mb-5 space-y-3">
        <h2 className="text-xl font-bold">{inventoryLabels.proposalsHeading}</h2>
        {orderedProposals.map(p=><SupervisorProposalCard key={p.id}
          threadId={p.threadId} proposalId={p.id} locale={locale as "en"|"es"|"ar"}/>)}
      </section>}
    <InventoryModifierPanel data={modifierSetup} t={inventoryLabels} locale={locale as "en"|"es"|"ar"}/>
  </PageShell>;
}

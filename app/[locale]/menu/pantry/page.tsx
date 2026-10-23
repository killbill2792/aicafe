import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import {readUsageBusinessDate, readUsageVariance} from "@/lib/data/usageVariance.server";
import { listPantry } from "@/lib/actions/pantry";
import {usageWeekEnding} from "@/lib/calc/usageDates";
import { PANTRY_STARTERS } from "@/lib/menu/pantryStarter";
import PageShell from "@/components/shared/PageShell";
import PantryWorkspace from "@/components/menu/PantryWorkspace";

export const dynamic = "force-dynamic";
export default async function PantryPage({searchParams}:{searchParams:Promise<{from?:string;to?:string}>}) {
  await requireOwnBusiness();
  const businessToday=await readUsageBusinessDate();
  const params=await searchParams;
  const valid=(d:string|undefined)=>!!d&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+"T00:00:00Z"));
  const to=valid(params.to)?params.to!:businessToday;
  const start=usageWeekEnding(to).from;
  const from=valid(params.from)&&params.from!<=to&&(Date.parse(to)-Date.parse(params.from!))/86400000<=30?params.from!:start; const [items,t,variance]=await Promise.all([listPantry(),getTranslations("MenuBuilder"),readUsageVariance({from,to,groupBy:"shift"}).catch(()=>null)]);
  return <PageShell className="px-4 pb-24 pt-6" wide>
    <PantryWorkspace businessToday={businessToday} variance={variance} items={items} starters={PANTRY_STARTERS.map(({key,name,category,baseUnit,packQuantity,packUnit})=>({key,name,category,baseUnit,packQuantity,packUnit}))}
      labels={Object.fromEntries(["title","search","all","coffee","milk","syrups","packaging","bakery","other","reviewNow","confirmed","add","packSize","packPrice","category","baseUnit","name","create","save","cancel","edit","estimate","confirm","usedIn","perUnit","priceUnknown","starterPack","chooseStarter","newIngredient","noItems","priceTitle","purchaseUnit","error","usageTitle","usagePeriod","usageExpected","usageActual","usageDifference","usageUnknown","usage_on_target","usage_watch","usage_over","usageMissing","usageRecord","usage_count","usage_purchase","usageIngredient","usageQuantity","usageUnit","usageDate","usageSaved","usageCountNote","usageShifts","usageExpectedOnly","usageStart","usageEnd","usageApply","usageStartCount","usageEndCount","usageCoverage","usageRecipeMissing","usageUnavailable"].map(key=>[key,t.raw(key as never) as string]))} />
  </PageShell>;
}

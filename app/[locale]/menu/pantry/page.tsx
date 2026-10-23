import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { readUsageVariance } from "@/lib/data/usageVariance.server";
import { listPantry } from "@/lib/actions/pantry";
import { PANTRY_STARTERS } from "@/lib/menu/pantryStarter";
import PageShell from "@/components/shared/PageShell";
import PantryWorkspace from "@/components/menu/PantryWorkspace";

export const dynamic = "force-dynamic";
export default async function PantryPage() {
  await requireOwnBusiness();
  const today=new Date().toISOString().slice(0,10); const from=new Date(Date.parse(today+"T12:00:00Z")-6*86400000).toISOString().slice(0,10); const [items,t,variance]=await Promise.all([listPantry(),getTranslations("MenuBuilder"),readUsageVariance({from,to:today}).catch(()=>null)]);
  return <PageShell className="px-4 pb-24 pt-6" wide>
    <PantryWorkspace variance={variance} items={items} starters={PANTRY_STARTERS.map(({key,name,category,baseUnit,packQuantity,packUnit})=>({key,name,category,baseUnit,packQuantity,packUnit}))}
      labels={Object.fromEntries(["title","search","all","coffee","milk","syrups","packaging","bakery","other","reviewNow","confirmed","add","packSize","packPrice","category","baseUnit","name","create","save","cancel","edit","estimate","confirm","usedIn","perUnit","priceUnknown","starterPack","chooseStarter","newIngredient","noItems","priceTitle","purchaseUnit","error","usageTitle","usagePeriod","usageExpected","usageActual","usageDifference","usageUnknown","usage_on_target","usage_watch","usage_over","usageMissing","usageRecord","usage_count","usage_purchase","usageIngredient","usageQuantity","usageUnit","usageDate","usageSaved","usageCountNote"].map(key=>[key,t.raw(key as never) as string]))} />
  </PageShell>;
}

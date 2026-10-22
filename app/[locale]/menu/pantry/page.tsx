import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { listPantry } from "@/lib/actions/pantry";
import { PANTRY_STARTERS } from "@/lib/menu/pantryStarter";
import PageShell from "@/components/shared/PageShell";
import PantryWorkspace from "@/components/menu/PantryWorkspace";

export const dynamic = "force-dynamic";
export default async function PantryPage() {
  await requireOwnBusiness();
  const [items, t] = await Promise.all([listPantry(), getTranslations("MenuBuilder")]);
  return <PageShell className="px-4 pb-24 pt-6" wide>
    <PantryWorkspace items={items} starters={PANTRY_STARTERS.map(({key,name,category,baseUnit,packQuantity,packUnit})=>({key,name,category,baseUnit,packQuantity,packUnit}))}
      labels={Object.fromEntries(["title","search","all","coffee","milk","syrups","packaging","bakery","other","reviewNow","confirmed","add","packSize","packPrice","category","baseUnit","name","create","save","cancel","edit","estimate","confirm","usedIn","perUnit","priceUnknown","starterPack","chooseStarter","newIngredient","noItems","priceTitle","purchaseUnit","error"].map(key=>[key,t.raw(key) as string]))} />
  </PageShell>;
}

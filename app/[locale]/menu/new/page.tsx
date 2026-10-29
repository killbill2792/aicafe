import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuGroupOptions } from "@/lib/actions/menuItems";
import BackHeader from "@/components/shared/BackHeader";
import NewMenuItemForm from "@/components/menu/NewMenuItemForm";
import PageShell from "@/components/shared/PageShell";
import { getMenuItemsForEdit } from "@/lib/data/getMenuItemsForEdit";
import { getSnapshot } from "@/lib/data/getSnapshot";

export const dynamic = "force-dynamic";

export default async function NewMenuItemPage() {
  await requireOwnBusiness();
  const [menuGroupOptions, t, common, menuItems, profile] = await Promise.all([getMenuGroupOptions(), getTranslations("ManageMenu"), getTranslations("Common"), getMenuItemsForEdit(), getSnapshot()]);
  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6" wide>
      <BackHeader title={t("addDrink")} backHref="/menu" backLabel={common("back")} />
      {!profile.business.currency&&<p role="note" className="text-sm text-ink-muted">{common("currencyNotSet")}</p>}
      <NewMenuItemForm currency={profile.business.currency} menuGroupOptions={menuGroupOptions} comboChoices={menuItems.items.map(item=>({id:item.id,name:item.name,sizeLabel:item.sizeLabel,priceCents:item.priceCents,costCents:item.ingredientsCostCents,estimated:item.ownerTotalCostStatus==="estimated"||item.costStatus!=="READY",menuGroup:item.menuGroup}))} />
    </PageShell>
  );
}

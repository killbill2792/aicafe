import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuGroupOptions } from "@/lib/actions/menuItems";
import BackHeader from "@/components/shared/BackHeader";
import NewMenuItemForm from "@/components/menu/NewMenuItemForm";

export const dynamic = "force-dynamic";

export default async function NewMenuItemPage() {
  await requireOwnBusiness();
  const [menuGroupOptions, t, common] = await Promise.all([getMenuGroupOptions(), getTranslations("ManageMenu"), getTranslations("Common")]);
  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <BackHeader title={t("addDrink")} backHref="/menu" backLabel={common("back")} />
      <NewMenuItemForm menuGroupOptions={menuGroupOptions} />
    </main>
  );
}

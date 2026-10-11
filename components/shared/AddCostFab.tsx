import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function AddCostFab({ hideOnMobile = false }: { hideOnMobile?: boolean } = {}) {
  const t = await getTranslations("Common");
  return (
    <Link
      href="/add-cost"
      className={`fixed bottom-[104px] end-4 z-10 h-14 items-center gap-2 rounded-full bg-ink px-5 font-bold text-paper shadow-lg md:bottom-6 ${hideOnMobile ? "hidden md:flex" : "flex"}`}
    >
      <Plus aria-hidden="true" size={22} />
      {t("addCost")}
    </Link>
  );
}

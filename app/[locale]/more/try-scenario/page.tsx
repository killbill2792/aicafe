import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

export default async function LegacyPlanRedirect() {
  redirect({ locale: await getLocale(), href: { pathname: "/more/plan", query: { tab: "what-if" } } });
}

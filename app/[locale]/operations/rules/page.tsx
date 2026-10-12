import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

/** Backward-compatible bookmark: rules now live directly in the Team workspace. */
export default async function TeamRulesRedirect(){
  redirect({href:"/operations",locale:await getLocale()});
}

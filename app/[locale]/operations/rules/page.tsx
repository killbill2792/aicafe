import {getLocale} from "next-intl/server";
import {redirect} from "@/i18n/navigation";
export default async function RulesRedirect(){redirect({href:"/staff/rules",locale:await getLocale()})}
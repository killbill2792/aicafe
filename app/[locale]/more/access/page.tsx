import {redirect} from "next/navigation";
import {getLocale} from "next-intl/server";
export default async function AccessSettingsPage(){redirect("/"+await getLocale()+"/pricing");}

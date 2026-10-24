import {getLocale} from "next-intl/server";
import {redirect} from "@/i18n/navigation";
import {staffManageRedirectQuery} from "@/lib/scheduling/staffScheduleLinks";
export default async function StaffRedirect({searchParams}:{searchParams:Promise<{employee?:string;date?:string;tab?:string}>}){
 const locale=await getLocale(),query=await searchParams;
 redirect({locale,href:{pathname:"/staff",query:staffManageRedirectQuery(query)}});
}
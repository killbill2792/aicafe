import {getLocale} from "next-intl/server";
import {redirect} from "@/i18n/navigation";
export default async function StaffRedirect({searchParams}:{searchParams:Promise<{employee?:string;date?:string;tab?:string}>}){
 const locale=await getLocale(),query=await searchParams;
 redirect({locale,href:{pathname:"/staff",query:{tab:query.date||query.tab==="schedule"?"schedule":"team",...(query.employee?{employee:query.employee}:{}),
  ...(query.date?{date:query.date}:{})}}});
}
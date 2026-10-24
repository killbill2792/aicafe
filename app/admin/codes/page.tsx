import {requireAdmin} from "@/lib/admin/auth.server";
import {getAdminCodeConsole} from "@/lib/data/adminCodes.server";
import CodeConsole from "@/components/admin/CodeConsole";
export const dynamic="force-dynamic";
const pageValue=(value:string|undefined)=>/^(0|[1-9][0-9]{0,3})$/.test(value??"0")?Number(value??"0"):0;
export default async function CodesPage({searchParams}:{
 searchParams:Promise<{page?:string;cafePage?:string}>}){
 await requireAdmin();
 const filters=await searchParams;
 const data=await getAdminCodeConsole(pageValue(filters.page),pageValue(filters.cafePage));
 return <CodeConsole {...data}/>;
}

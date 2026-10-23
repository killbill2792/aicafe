import {requireAdmin} from "@/lib/admin/auth.server";
import {getAdminCodeConsole} from "@/lib/data/adminCodes.server";
import CodeConsole from "@/components/admin/CodeConsole";
export const dynamic="force-dynamic";
export default async function CodesPage({searchParams}:{
 searchParams:Promise<{page?:string}>}){
 await requireAdmin();
 const raw=(await searchParams).page??"0";
 const page=/^(0|[1-9][0-9]{0,3})$/.test(raw)?Number(raw):0;
 const data=await getAdminCodeConsole(page);
 return <CodeConsole {...data}/>;
}

import {requireAdmin} from "@/lib/admin/auth.server";
import {getAdminCodeConsole} from "@/lib/data/adminCodes.server";
import CodeConsole from "@/components/admin/CodeConsole";
export const dynamic="force-dynamic";
export default async function CodesPage(){
 await requireAdmin();
 const data=await getAdminCodeConsole();
 return <CodeConsole {...data}/>;
}

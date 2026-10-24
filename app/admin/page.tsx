import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin/auth.server";
export default async function AdminPage(){await requireAdmin();redirect("/admin/cafes");}

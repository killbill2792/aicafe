import type { ReactNode } from "react";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin/auth.server";
import "../globals.css";
export const dynamic="force-dynamic";
export const metadata={title:"AI CAFE · Internal admin",robots:{index:false,follow:false}};
export default async function AdminLayout({children}:{children:ReactNode}) {
  await requireAdmin();
  return <html lang="en" dir="ltr"><body className="min-h-screen bg-slate-50 text-slate-900">
    <header className="border-b bg-white p-4"><nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-4">
      <Link href="/admin" className="font-bold">AI CAFE · Admin</Link>
      <Link href="/admin/cafes">Cafes</Link><Link href="/admin/conversations">Conversations</Link>
      <Link href="/admin/costs">Costs</Link><Link href="/admin/patterns">Patterns</Link>
      <Link href="/admin/proactive">Proactive</Link>
    </nav></header><main className="mx-auto max-w-6xl p-5">{children}</main>
  </body></html>;
}

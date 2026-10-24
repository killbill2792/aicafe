import Link from "next/link";
import { notFound } from "next/navigation";
import { getCafe } from "@/lib/admin/data.server";
export const dynamic="force-dynamic";
export default async function CafePage({params}:{params:Promise<{cafeId:string}>}){
  const {cafeId}=await params;const c=await getCafe(cafeId);if(!c)notFound();
  return <section className="space-y-4"><Link href="/admin/cafes" className="text-blue-700 underline">← All cafes</Link>
    <h1 className="text-2xl font-bold">{c.name}</h1>
    <dl className="grid gap-3 rounded-xl border bg-white p-5 sm:grid-cols-2">
      {([["Owners",c.owners.join(", ")||"—"],["Signed up",c.created_at],["Last active",c.lastActive??"Unknown"],
        ["POS connection",c.pos?`${c.pos.provider}: ${c.pos.status}`:"Not connected"],["Imported sales",c.firstSale?`${c.firstSale} to ${c.lastSale}`:"No sales recorded"],
        ["Staff count",String(c.staffCount??"Unknown")],["Menu items",String(c.menuCount??"Unknown")],
        ["Access",c.access.mode==="grandfathered"?"Full access":c.access.mode==="paused"?"Paused":c.access.active?"Free until "+c.access.accessEnd:"Expired"]] as const).map(([label,value])=><div key={label}><dt className="text-sm text-slate-500">{label}</dt><dd className="break-words font-medium">{value}</dd></div>)}
    </dl><Link className="text-blue-700 underline" href={`/admin/conversations?cafe=${c.id}`}>View conversations →</Link>
  </section>;
}

import Link from "next/link";
import { listCafes } from "@/lib/admin/data.server";
export const dynamic="force-dynamic";
export default async function CafesPage(){
  const cafes=await listCafes();
  return <section><h1 className="mb-2 text-2xl font-bold">Cafes</h1><p className="mb-5 text-sm text-slate-600">{cafes.length} recent cafes · read only</p>
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm">
      <thead className="bg-slate-100"><tr>{["Cafe","Owner","Signup","Last active","POS","Sales dates","Staff","Menu","Access"].map(x=><th className="p-3" key={x}>{x}</th>)}</tr></thead>
      <tbody>{cafes.map(c=><tr key={c.id} className="border-t">
        <td className="p-3"><Link className="font-semibold text-blue-700 underline" href={`/admin/cafes/${c.id}`}>{c.name}</Link></td>
        <td className="p-3">{c.owners.join(", ")||"—"}</td>
        <td className="p-3">{c.created_at.slice(0,10)}</td><td className="p-3">{c.lastActive?.slice(0,10)??"—"}</td>
        <td className="p-3">{c.pos?`${c.pos.provider}: ${c.pos.status}`:"Not connected"}</td>
        <td className="p-3">{c.firstSale?`${c.firstSale} – ${c.lastSale}`:"None"}</td>
        <td className="p-3">{c.staffCount??"—"}</td><td className="p-3">{c.menuCount??"—"}</td>
        <td className="p-3">{c.is_demo?"Demo":"Standard"}</td>
      </tr>)}</tbody>
    </table></div></section>;
}

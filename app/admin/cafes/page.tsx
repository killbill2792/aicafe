import Link from "next/link";
import { listCafes } from "@/lib/admin/data.server";
export const dynamic="force-dynamic";
export default async function CafesPage({searchParams}:{searchParams:Promise<{page?:string}>}){
  const raw=(await searchParams).page??"0";
  const page=/^(0|[1-9][0-9]{0,3})$/.test(raw)?Number(raw):0;
  const {cafes,total,pageSize}=await listCafes(page);
  return <section><h1 className="mb-2 text-2xl font-bold">Cafes</h1><p className="mb-5 text-sm text-slate-600">{cafes.length} of {total} cafés · read only</p>
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm">
      <thead className="bg-slate-100"><tr>{["Cafe","Owner","Signup","Last active","POS","Sales dates","Staff","Menu","Access"].map(x=><th className="p-3" key={x}>{x}</th>)}</tr></thead>
      <tbody>{cafes.map(c=><tr key={c.id} className="border-t">
        <td className="p-3"><Link className="font-semibold text-blue-700 underline" href={`/admin/cafes/${c.id}`}>{c.name}</Link></td>
        <td className="p-3">{c.owners.join(", ")||"—"}</td>
        <td className="p-3">{c.created_at.slice(0,10)}</td><td className="p-3">{c.lastActive?.slice(0,10)??"—"}</td>
        <td className="p-3">{c.pos?`${c.pos.provider}: ${c.pos.status}`:"Not connected"}</td>
        <td className="p-3">{c.firstSale?`${c.firstSale} – ${c.lastSale}`:"None"}</td>
        <td className="p-3">{c.staffCount??"—"}</td><td className="p-3">{c.menuCount??"—"}</td>
        <td className="p-3">{c.access.mode==="grandfathered"?"Full access":c.access.mode==="paused"?"Paused":c.access.active?"Free until "+c.access.accessEnd:"Expired"}</td>
      </tr>)}</tbody>
    </table></div>
    <nav className="mt-4 flex gap-4 text-[17px]" aria-label="Café list pages">
      {page>0&&<Link className="underline" href={"/admin/cafes?page="+(page-1)}>Previous cafés</Link>}
      {(page+1)*pageSize<total&&<Link className="underline" href={"/admin/cafes?page="+(page+1)}>Next cafés</Link>}
    </nav>
  </section>;
}

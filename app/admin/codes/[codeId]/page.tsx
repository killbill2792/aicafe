import Link from "next/link";
import {notFound} from "next/navigation";
import {requireAdmin} from "@/lib/admin/auth.server";
import {getCodeRedemptionPage} from "@/lib/data/adminCodeRedemptions.server";
export const dynamic="force-dynamic";
export default async function RedemptionsPage({params,searchParams}:{
 params:Promise<{codeId:string}>;searchParams:Promise<{page?:string}>}){
 await requireAdmin();
 const {codeId}=await params;
 const input=(await searchParams).page??"0";
 const page=/^(0|[1-9][0-9]{0,3})$/.test(input)?Number(input):0;
 const data=await getCodeRedemptionPage(codeId,page);
 if(!data)notFound();
 return <section className="space-y-4">
  <Link className="underline" href="/admin/codes">← All codes</Link>
  <h1 className="text-2xl font-bold">Redemptions: {data.code.code_hint}</h1>
  <p>{data.total} cafés redeemed; maximum {data.code.max_cafes}</p>
  <div className="overflow-x-auto rounded border bg-white"><table className="w-full text-left">
   <thead><tr>{["Café","Redeemed by","Date","Access end at redemption"].map(x=><th className="p-3" key={x}>{x}</th>)}</tr></thead>
   <tbody>{data.rows.map(r=><tr className="border-t" key={r.business_id}>
    <td className="p-3">{r.cafeName}</td><td className="p-3">{r.ownerEmail}</td>
    <td className="p-3">{r.redeemed_at.slice(0,10)}</td><td className="p-3">{r.access_end}</td>
   </tr>)}</tbody>
  </table></div>
  <nav className="flex gap-4">
   {page>0&&<Link className="underline" href={`/admin/codes/${codeId}?page=${page-1}`}>Previous</Link>}
   {(page+1)*data.pageSize<data.total&&
    <Link className="underline" href={`/admin/codes/${codeId}?page=${page+1}`}>Next</Link>}
  </nav>
 </section>;
}

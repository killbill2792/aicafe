"use client";
import {useEffect,useRef,useState,type FormEvent} from "react";
import {formatCents} from "@/lib/calc";
import {parseSupplierDollars,compareSupplierQuotePrices} from "@/lib/calc/supplierQuotes";
import type {PublicSource} from "@/lib/ai/suppliers/contracts";
type Quote={id:string;supplierName:string;itemName:string;priceCents:number;
 packageCount:number;packageUnit:string;sourceKind:string;sourceUrl:string|null;
 quotedOn:string;evidenceStatus:string;createdAt:string};
export type SupplierCopy={
 title:string;description:string;supplier:string;item:string;price:string;count:string;
 unit:string;sourceKind:string;sourceUrl:string;date:string;save:string;saving:string;
 saved:string;error:string;history:string;empty:string;notVerified:string;
 search:string;searchButton:string;searchUnavailable:string;webNotice:string;comparison:string;
};
const field="min-h-12 w-full rounded-xl border border-[#B9A995] bg-white p-3 text-[17px] text-ink";
async function read<T>(resp:Response):Promise<T>{if(!resp.ok)throw new Error();return resp.json() as Promise<T>;}
export default function SupplierEvidenceManager({copy}:{copy:SupplierCopy}){
 const [supplier,setSupplier]=useState("");
 const [item,setItem]=useState("");
 const [dollars,setDollars]=useState("");
 const [count,setCount]=useState("1");
 const [unit,setUnit]=useState("each");
 const [kind,setKind]=useState("supplier_quote");
 const [url,setUrl]=useState("");
 const [quotedOn,setQuotedOn]=useState("");
 const [quotes,setQuotes]=useState<Quote[]>([]);
 const [query,setQuery]=useState("");
 const [sources,setSources]=useState<PublicSource[]>([]);
 const [notice,setNotice]=useState("");
 const [busy,setBusy]=useState(false);
 const requestId=useRef<string|null>(null);
 useEffect(()=>{
  const ctl=new AbortController();
  void fetch("/api/ai/suppliers/quotes",{signal:ctl.signal,cache:"no-store"})
   .then(read<{items:Quote[]}>)
   .then(result=>{if(!ctl.signal.aborted)setQuotes(result.items);})
   .catch(()=>{if(!ctl.signal.aborted)setNotice(copy.error);});
  return ()=>ctl.abort();
 },[copy.error]);
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();
  const cents=parseSupplierDollars(dollars);
  if(!cents||busy)return;
  setBusy(true);setNotice("");
  requestId.current??=crypto.randomUUID();
  try{
   const result=await read<{quote:Quote}>(await fetch("/api/ai/suppliers/quotes",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({requestId:requestId.current,supplierName:supplier,itemName:item,
     priceCents:cents,packageCount:Number(count),packageUnit:unit,sourceKind:kind,
     sourceUrl:url.trim()||null,quotedOn:quotedOn||new Date().toISOString().slice(0,10)}),
   }));
   setQuotes((prev)=>[result.quote,...prev.filter(q=>q.id!==result.quote.id)]);
   setNotice(copy.saved);setSupplier("");setItem("");setDollars("");setUrl("");
   requestId.current=null;
  }catch{setNotice(copy.error);}
  finally{setBusy(false);}
 }
 async function research(){
  if(query.trim().length<3||busy)return;
  setBusy(true);setNotice("");setSources([]);
  try{
   const data=await read<{sources:PublicSource[]}>(await fetch(
    "/api/ai/suppliers/research?q="+encodeURIComponent(query.trim()),{cache:"no-store"}));
   setSources(data.sources);
  }catch{setNotice(copy.searchUnavailable);}
  finally{setBusy(false);}
 }
 const comparison=quotes.length>1&&quotes[0].itemName.toLocaleLowerCase()===quotes[1].itemName.toLocaleLowerCase()
  ?compareSupplierQuotePrices(quotes[1],quotes[0]):null;
 return <div className="flex flex-col gap-4">
  <p className="rounded-2xl border border-[#D8C8B5] bg-[#FFF4E0] p-4 text-[17px] text-ink">
   {copy.description}</p>
  <form onSubmit={(e)=>void submit(e)} className="rounded-2xl bg-card p-4">
   <div className="grid gap-3 md:grid-cols-2">
    {([[copy.supplier,supplier,setSupplier],[copy.item,item,setItem],[copy.price,dollars,setDollars]] as const).map(
     ([label,value,change])=><label key={label} className="text-[17px] font-semibold text-ink">{label}
      <input className={field+" mt-1"} required maxLength={120} value={value}
       onChange={e=>{change(e.target.value);requestId.current=null;}}/></label>)}
    <label className="text-[17px] font-semibold text-ink">{copy.count}
     <input className={field+" mt-1"} type="number" min="1" max="100000" required
      value={count} onChange={e=>{setCount(e.target.value);requestId.current=null;}}/></label>
    <label className="text-[17px] font-semibold text-ink">{copy.unit}
     <select className={field+" mt-1"} value={unit} onChange={e=>{setUnit(e.target.value);requestId.current=null;}}>
      {["each","oz","lb","kg","gal","liter","case"].map(x=><option key={x}>{x}</option>)}</select></label>
    <label className="text-[17px] font-semibold text-ink">{copy.sourceKind}
     <select className={field+" mt-1"} value={kind} onChange={e=>{setKind(e.target.value);requestId.current=null;}}>
      {["supplier_quote","supplier_email","public_listing"].map(x=><option key={x}>{x}</option>)}</select></label>
    <label className="text-[17px] font-semibold text-ink">{copy.sourceUrl}
     <input className={field+" mt-1"} type="url" value={url}
      onChange={e=>{setUrl(e.target.value);requestId.current=null;}}/></label>
    <label className="text-[17px] font-semibold text-ink">{copy.date}
     <input className={field+" mt-1"} type="date" value={quotedOn}
      max={new Date().toISOString().slice(0,10)}
      onChange={e=>{setQuotedOn(e.target.value);requestId.current=null;}}/></label>
   </div>
   <button className="mt-4 min-h-12 rounded-full bg-ink px-5 text-[17px] font-bold text-paper"
    disabled={busy||!parseSupplierDollars(dollars)}>{busy?copy.saving:copy.save}</button>
  </form>
  <section className="rounded-2xl bg-card p-4">
   <h2 className="font-headline text-2xl font-bold text-ink">{copy.history}</h2>
   {!quotes.length&&<p className="mt-2 text-[17px] text-ink-muted">{copy.empty}</p>}
   {comparison?.comparable&&<p className="mt-3 text-[17px] text-ink">
    {copy.comparison}: {formatCents(comparison.differenceCents)} ({copy.notVerified})</p>}
   <ul className="mt-3 space-y-3">{quotes.map(q=><li key={q.id}
    className="rounded-xl border border-[#D8C8B5] p-3 text-[17px] text-ink">
    <strong>{q.itemName} · {formatCents(q.priceCents)}</strong>
    <p>{q.supplierName} · {q.packageCount} {q.packageUnit} · {q.quotedOn}</p>
    <p className="text-ink-muted">{copy.notVerified} · {q.sourceKind}</p>
    {q.sourceUrl&&<a href={q.sourceUrl} rel="noopener noreferrer" target="_blank"
     className="underline">{copy.sourceUrl}</a>}
   </li>)}</ul>
  </section>
  <section className="rounded-2xl bg-card p-4">
   <h2 className="font-headline text-2xl font-bold text-ink">{copy.search}</h2>
   <p className="mt-2 text-[17px] text-ink-muted">{copy.webNotice}</p>
   <div className="mt-2 flex flex-wrap gap-2">
    <input className={field+" flex-1"} value={query} maxLength={120}
     onChange={e=>setQuery(e.target.value)}/>
    <button type="button" onClick={()=>void research()} disabled={busy||query.trim().length<3}
     className="min-h-12 rounded-full bg-ink px-5 text-[17px] font-bold text-paper disabled:opacity-50">{copy.searchButton}</button>
   </div>
   <ul className="mt-3 space-y-2">{sources.map((source)=><li key={source.url}
    className="rounded-xl border border-[#D8C8B5] p-3">
    <a href={source.url} target="_blank" rel="noopener noreferrer"
     className="break-all text-[17px] font-semibold text-ink underline">{source.title}</a>
    <p className="text-[17px] text-ink-muted">{source.snippet}</p>
    <p className="text-sm text-ink-muted">{copy.notVerified} · {source.queriedAt}</p>
   </li>)}</ul>
  </section>
  <p role="status" aria-live="polite" className="text-[17px] text-ink">{notice}</p>
 </div>;
}

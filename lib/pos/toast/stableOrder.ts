// Toast returns some lists inside an order (applied taxes, selections, …) in a
// different order on every download. The archive keeps a new version of an
// order when its content hash changes, so an unchanged order was saved again
// on every re-pull. Sorting every list whose items all carry a Toast GUID gives
// the same content the same hash. Nothing is added or removed, and lists
// without GUIDs keep Toast's order.

type Json=unknown;

const guidOf=(v:Json)=>v&&typeof v==="object"&&!Array.isArray(v)&&
 typeof (v as Record<string,unknown>).guid==="string"?(v as Record<string,string>).guid:null;

function stable(value:Json,depth:number):Json{
 if(depth>40)return value;
 if(Array.isArray(value)){
  const items=value.map(v=>stable(v,depth+1));
  if(items.length<2||!items.every(v=>guidOf(v)!==null))return items;
  // Stable sort: equal GUIDs keep their relative order.
  return items.map((v,i)=>({v,i,g:guidOf(v)!}))
   .sort((a,b)=>a.g<b.g?-1:a.g>b.g?1:a.i-b.i).map(x=>x.v);
 }
 if(value&&typeof value==="object"){
  const out:Record<string,Json>={};
  for(const [k,v] of Object.entries(value as Record<string,Json>))out[k]=stable(v,depth+1);
  return out;
 }
 return value;
}

/** One Toast order with every GUID list inside it in GUID order. */
export function stableToastOrder<T>(order:T):T{
 return stable(order,0) as T;
}

/** A page of orders: the page keeps Toast's order, each order is made stable. */
export function stableToastOrderPage(page:unknown[]):unknown[]{
 return page.map(o=>stableToastOrder(o));
}

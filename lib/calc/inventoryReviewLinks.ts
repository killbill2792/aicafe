/** Inventory review links never widen proposal scope: the server must re-read by owner and thread. */
export function reviewInventoryHref(ids:readonly string[]){
 return "/menu/pantry?proposals="+encodeURIComponent(ids.join(","));
}
export function selectRequestedPurchases<T extends {id:string}>(ids:readonly string[],scopedRows:readonly T[]){
 return ids.flatMap(id=>{const row=scopedRows.find(p=>p.id===id);return row?[row]:[];});
}
export function hasInventoryReviewLink(purchaseCount:number){return purchaseCount>=2;}

import type {PosCatalogItem,PosProvider} from "./types";

export type CanonicalMenuCandidate={
 id:string;name:string;baseName?:string|null;sizeLabel:string|null;
 priceCents:number|null;category:string|null;posItemId:string|null;
 catalogSource?:string|null
};
export type CatalogMatch={imported:PosCatalogItem;candidateId:string|null;
 score:number;status:"matched"|"needs_review"|"new"};
const normalize=(value:string|null|undefined)=>(value??"").toLocaleLowerCase().normalize("NFKD")
 .replace(/\p{M}/gu,"").replace(/[^\p{L}\p{N}]+/gu," ").trim();

/** Immutable provider GUID wins, then matching is exact size/name and conservative. */
export function matchCatalogItem(imported:PosCatalogItem,candidates:CanonicalMenuCandidate[],
 provider?:PosProvider):CatalogMatch{
 const external=candidates.find(c=>c.posItemId===imported.posItemId);
 if(external)return {imported,candidateId:external.id,score:1,status:"matched"};
 const inputName=normalize(imported.baseName??imported.name);
 const inputSize=normalize(imported.sizeLabel??null);
 const source=provider??(imported.posItemId.startsWith("toast:")?"toast":undefined);
 const matchingNames=candidates.filter(c=>(
   normalize(c.baseName??c.name)===inputName&&normalize(c.sizeLabel)===inputSize
 ));
 // GUIDs within one provider identify distinct rows, even with identical labels.
 const same=matchingNames.filter(c=>!(source&&c.catalogSource===source&&
   c.posItemId!==null&&c.posItemId!==imported.posItemId));
 if(!same.length){
  if(matchingNames.length)return {imported,candidateId:null,score:0,status:"new"};
  const legacy=candidates.filter(c=>!(source&&c.catalogSource===source&&c.posItemId!==null)&&
   normalize(c.name)===normalize(imported.name));
  if(legacy.length)return {imported,candidateId:legacy.length===1?legacy[0].id:null,
   score:0.6,status:"needs_review"};
  return {imported,candidateId:null,score:0,status:"new"};
 }
 const equalPrice=(c:CanonicalMenuCandidate)=>imported.priceCents!==null&&
    c.priceCents===imported.priceCents;
 const exactPrice=same.filter(equalPrice);
 const chosen=(exactPrice.length===1?exactPrice[0]:same[0]);
 // Exact size/name/price is needed for manual records; the CSV median is not a
 // provider authority and may be different to the current published POS price.
 const manual=chosen.catalogSource===undefined||chosen.catalogSource==="manual"||
   chosen.posItemId===null;
 const single=same.length===1;
 const csv=chosen.posItemId?.startsWith("csv-item-")||chosen.catalogSource==="csv";
 const importedCsv=imported.posItemId.startsWith("csv-item-");
 const sourceConflict=chosen.posItemId!==null&&!csv&&!importedCsv&&
   chosen.posItemId!==imported.posItemId;
 const matched=single&&!sourceConflict&&(csv||importedCsv||equalPrice(chosen));
 return {imported,candidateId:single?chosen.id:null,
  score:matched?1:manual?0.6:0.7,status:matched?"matched":"needs_review"};
}
export function catalogSourceFor(provider:PosProvider):"csv"|"square"|"toast"|"clover"|"other_pos" {
 return provider==="demo"?"other_pos":provider;
}

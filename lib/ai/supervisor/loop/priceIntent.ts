import {z} from "zod";

/** The model supplies an untrusted candidate, not proof of owner intent. */
export const priceProposalToolSchema=z.strictObject({
  productId:z.uuid().nullable(),
  productReference:z.string().nullable(),
  ownerProductQuote:z.string().nullable(),
  variantStatus:z.enum(["unique","ambiguous","unknown"]),
  amountMode:z.enum(["increase","target","ambiguous"]),
  increaseCents:z.number().int().safe().positive().max(100000).nullable(),
  targetPriceCents:z.number().int().safe().nonnegative().max(100000).nullable(),
  ownerAmountQuote:z.string().nullable(),
  amountStatus:z.enum(["unique","ambiguous","unknown"]),
});
export const priceProposalToolJsonSchema=z.toJSONSchema(priceProposalToolSchema,{
  unrepresentable:"any",reused:"inline",
});
const words=(s:string)=>s.toLocaleLowerCase("en").normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const quoted=(q:string,texts:readonly string[])=>texts.some(t=>t.normalize("NFKC").toLocaleLowerCase("en").includes(q.normalize("NFKC").toLocaleLowerCase("en")));
export function validatePriceProposalCandidate(raw:unknown,catalog:readonly {
 id:string;name:string;baseName:string;sizeLabel?:string|null;active:boolean;
}[],ownerTexts:readonly string[]):{productId:string;increaseCents:number}|null{
 const p=priceProposalToolSchema.safeParse(raw);
 if(!p.success)return null;
 const x=p.data;
 if(x.variantStatus!=="unique"||x.amountStatus!=="unique"||x.amountMode!=="increase"||
   x.productId===null||x.increaseCents===null||x.targetPriceCents!==null||
   !x.ownerProductQuote||!x.productReference||!x.ownerAmountQuote)return null;
 if(!quoted(x.ownerProductQuote,ownerTexts)||!quoted(x.ownerAmountQuote,ownerTexts))return null;
 if(words(x.ownerProductQuote).sort().join("|")!==words(x.productReference).sort().join("|"))return null;
 const selected=words(x.productReference);
 if(selected.length===0)return null;
 const matching=catalog.filter(item=>item.active&&[
   item.name,item.baseName,item.sizeLabel?item.baseName+" "+item.sizeLabel:item.name,
 ].some(label=>selected.every(word=>words(label).includes(word))));
 return matching.length===1&&matching[0].id===x.productId?
   {productId:x.productId,increaseCents:x.increaseCents}:null;
}


/** Domain-owned, source-verified ambiguous selection for the generic owner-input
 * mechanism. An ungrounded model claim alone is never enough to offer IDs. */
export function ambiguousPriceProposalOptions(raw:unknown,catalog:readonly {
  id:string;name:string;baseName:string;sizeLabel?:string|null;active:boolean;priceCents?:number|null;
}[],ownerTexts:readonly string[]){
  const parsed=priceProposalToolSchema.safeParse(raw);
  if(!parsed.success||!parsed.data.ownerProductQuote||
    !quoted(parsed.data.ownerProductQuote,ownerTexts))return [];
  const normalize=(s:string)=>s.normalize("NFKC").trim().toLocaleLowerCase("en");
  const reference=normalize(parsed.data.ownerProductQuote);
  const matches=catalog.filter(item=>item.active&&normalize(item.baseName)===reference);
  if(matches.length<2||matches.length>30)return [];
  return matches.map(item=>{
    const label=item.name+(item.sizeLabel?" — "+item.sizeLabel:"")+
      (typeof item.priceCents==="number"?" — "+(item.priceCents/100).toFixed(2)+" USD":"");
    return {id:item.id,label:{en:label,es:label,ar:label}};
  });
}

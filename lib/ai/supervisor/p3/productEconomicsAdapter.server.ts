import "server-only";
import { outputFor } from "@/lib/metrics/p1Readers.server";
import { values } from "@/lib/metrics/p1Catalog";
import { isWholeNamedEntity } from "./entityMatch";
import type { ShadowEvidence,ShadowRegistry } from "@/lib/ai/supervisor/p2/shadow.server";
import type { TrustedReadScope,ResultStatus } from "@/lib/ai/supervisor/p2/registry";

/** Domain-owned P1 dependency: the product ID is independently resolved from
 * canonical menu evidence. The owner/model never gets to invent a productId.
 * Optional enrichment consumes the same bounded source-read budget.
 */
export async function enrichResolvedProductEconomics(input:{
  goal:string;scope:TrustedReadScope;registry:ShadowRegistry;
  evidence:readonly ShadowEvidence[];remainingReads:number;
  ownerHistory?:readonly string[];
}):Promise<{evidence:ShadowEvidence[];readCount:number}>{
  const result:ShadowEvidence[]=[...input.evidence];
  const verifiedByProduct=new Map<string,ShadowEvidence>();
  let readCount=0;
  for(const item of input.evidence){
    if(item.capabilityId!=="p3.menu.catalog.v1")continue;
    const parsed=outputFor("menu.catalog").safeParse(item.result);
    if(!parsed.success||parsed.data.status==="unavailable")continue;
    const catalog=values["menu.catalog"].safeParse(parsed.data.value);
    if(!catalog.success)continue;
    const matchesCurrent=catalog.data.filter(product=>
      isWholeNamedEntity(item.clause,product.name,catalog.data,true));
    const historical=(input.ownerHistory??[]).slice(-3).join(" ");
    const matchesHistory=catalog.data.filter(product=>
      isWholeNamedEntity(historical,product.name,catalog.data,true));
    const namedElsewhere=catalog.data.filter(product=>
      isWholeNamedEntity(input.goal,product.name,catalog.data,true));
    const uniquePrevious=matchesCurrent.length===0&&namedElsewhere.length===0&&
      matchesHistory.length===1;
    for(const product of catalog.data){
      if(!product.active||!product.name||!product.id||
        product.id.length>120||
        !(matchesCurrent.some(match=>match.id===product.id)||
          uniquePrevious&&matchesHistory[0].id===product.id))
        continue;
      const cached=verifiedByProduct.get(product.id);
      if(cached){result.push({...cached,clause:item.clause});continue;}
      if(readCount>=input.remainingReads)break;
      const read=await input.registry.invoke(input.scope,
        "p3.menu.product_economics.v1",{
          id:"menu.product_economics",version:1,
          purpose:"current_recipe_cost_review",productId:product.id,
        });
      // A successful read must return the *same* canonical menu product
      // independently resolved before the query. Reject swapped, stale or
      // ambiguous product identities instead of attaching another product's
      // price/recipe costs to the owner's requested item.
      readCount++;
      const parsedEconomics=outputFor("menu.product_economics").safeParse(read);
      if(!parsedEconomics.success||parsedEconomics.data.status==="unavailable")
        continue;
      const economics=values["menu.product_economics"].safeParse(parsedEconomics.data.value);
      if(!economics.success||economics.data.id!==product.id||
        economics.data.name.normalize("NFKC").toLocaleLowerCase()!==
          product.name.normalize("NFKC").toLocaleLowerCase())
        continue;
      const value=parsedEconomics.data as {status?:string;reason?:string};
      const enriched:ShadowEvidence={
        clause:item.clause,capabilityId:"p3.menu.product_economics.v1",
        status:(["verified","estimated","partial"].includes(value.status??"")?
          value.status:"unavailable") as ResultStatus,
        result:read,reason:typeof value.reason==="string"?value.reason:null,
      };
      verifiedByProduct.set(product.id,enriched);
      result.push(enriched);
    }
  }
  return {evidence:result,readCount};
}

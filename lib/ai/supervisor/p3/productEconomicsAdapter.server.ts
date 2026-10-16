import "server-only";
import { outputFor } from "@/lib/metrics/p1Readers.server";
import { values } from "@/lib/metrics/p1Catalog";
import type { ShadowEvidence,ShadowRegistry } from "@/lib/ai/supervisor/p2/shadow.server";
import type { TrustedReadScope,ResultStatus } from "@/lib/ai/supervisor/p2/registry";

/** Domain-owned P1 dependency: the product ID is independently resolved from
 * canonical menu evidence. The owner/model never gets to invent a productId.
 * Optional enrichment consumes the same bounded source-read budget.
 */
export async function enrichResolvedProductEconomics(input:{
  goal:string;scope:TrustedReadScope;registry:ShadowRegistry;
  evidence:readonly ShadowEvidence[];remainingReads:number;
}):Promise<{evidence:ShadowEvidence[];readCount:number}>{
  const result:ShadowEvidence[]=[...input.evidence];
  const names=input.goal.normalize("NFKC").toLocaleLowerCase();
  const chosen=new Set<string>();
  let readCount=0;
  for(const item of input.evidence){
    if(item.capabilityId!=="p3.menu.catalog.v1"||readCount>=input.remainingReads)continue;
    const parsed=outputFor("menu.catalog").safeParse(item.result);
    if(!parsed.success||parsed.data.status==="unavailable")continue;
    const catalog=values["menu.catalog"].safeParse(parsed.data.value);
    if(!catalog.success)continue;
    for(const product of catalog.data){
      if(readCount>=input.remainingReads)break;
      if(!product.active||!product.name||!product.id||
        product.id.length>120||chosen.has(product.id)||
        !names.includes(product.name.normalize("NFKC").toLocaleLowerCase()))
        continue;
      chosen.add(product.id);
      const read=await input.registry.invoke(input.scope,
        "p3.menu.product_economics.v1",{
          id:"menu.product_economics",version:1,
          purpose:"current_recipe_cost_review",productId:product.id,
        });
      if(!read||typeof read!=="object")continue;
      const value=read as {status?:string;reason?:string};
      readCount++;
      result.push({
        clause:item.clause,capabilityId:"p3.menu.product_economics.v1",
        status:(["verified","estimated","partial"].includes(value.status??"")?
          value.status:"unavailable") as ResultStatus,
        result:read,reason:typeof value.reason==="string"?value.reason:null,
      });
    }
  }
  return {evidence:result,readCount};
}

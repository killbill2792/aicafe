import "server-only";
import {z} from "zod";
import {researchEnabled,researchPublicSources} from "@/lib/ai/suppliers/research.server";
import {researchQuery} from "@/lib/ai/suppliers/contracts";
import {schemaFingerprint,type ReadRegistration} from "../p2/registry";
const inputSchema=z.strictObject({purpose:z.literal("public_market_research"),query:researchQuery});
const outputSchema=z.union([
  z.strictObject({status:z.literal("unavailable"),value:z.null(),reason:z.string().max(100)}),
  z.strictObject({status:z.literal("partial"),id:z.literal("public.research"),
    value:z.array(z.strictObject({title:z.string().max(160),url:z.url().max(2000),
      snippet:z.string().max(400),queriedAt:z.string().datetime(),
      evidenceStatus:z.literal("unverified_search_snippet")})).max(5),
    provenance:z.strictObject({sourceId:z.literal("public.search"),canonicalReaderId:z.literal("public.brave.search"),
      sourceRevision:z.null(),asOf:z.string(),purpose:z.literal("public_market_research")}),
    quality:z.strictObject({missingInputs:z.array(z.string()),estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
  }),
]);
export function buildResearchRegistration(publicContext:()=>string=()=>""):ReadRegistration{
  const id="p3.public.research.v1";
  return {id,version:1,owner:"maya",mode:"read",availability:"shadow",
    purpose:"Find public competitor/menu/supplier/market sources when the owner asks for external research. Search snippets are unverified leads, not confirmed current prices. Never send private café/person/payroll records in the query.",
    sourceIds:["public.search"],canonicalReaderIds:["public.brave.search"],allowedPurposes:["public_market_research"],
    inputSchema,outputSchema,schemaContract:{id:id+".v1",registrationId:id,version:1,
      inputSchemaFingerprint:schemaFingerprint(inputSchema),outputSchemaFingerprint:schemaFingerprint(outputSchema)},
    requiredRole:"owner",sensitivity:"normal",requiresApproval:false,effectPolicy:"deny",
    budgets:{maxOperations:1,timeoutMs:10000,maxInputBytes:2000,maxResultBytes:20000,maxRangeDays:1},
    async read(scope,raw){
      if(!researchEnabled())return {status:"unavailable",value:null,reason:"research_not_connected"};
      const input=inputSchema.parse(raw);
      // Outbound queries may use only the current research request and approved
      // public location fields, never prior owner statements/thread memory or
      // private numeric/person data learned from financial/staff tools.
      const words=(v:string)=>v.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
      const allowed=new Set(words(publicContext()+" cafe café coffee menu price prices competitor competitors nearby supplier suppliers public research location café precios competidores proveedores قائمة أسعار مقهى منافسين موردين"));
      if(words(input.query).some(w=>!allowed.has(w)))
        return {status:"unavailable",value:null,reason:"research_query_contains_unapproved_terms"};
      const value=await researchPublicSources(input.query);
      if(!value.length)return {status:"unavailable",value:null,reason:"no_public_sources_found"};
      return {status:"partial",id:"public.research",value,
        provenance:{sourceId:"public.search",canonicalReaderId:"public.brave.search",sourceRevision:null,
          asOf:scope.identity.asOf,purpose:input.purpose},
        quality:{missingInputs:["search_snippets_unverified"],estimatedInputs:[],staleInputs:[]}};
    }};
}

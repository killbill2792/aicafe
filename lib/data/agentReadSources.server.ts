import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOpenHours, OPEN_HOURS_DAY_KEYS } from "@/lib/business/openHours";

/** Existing owner-authenticated client. Never accepts model-supplied business scope. */
export function agentSourceReaders(client:SupabaseClient,authorizedBusinessId:string){
  const assertScope=(requested:string)=>{
    if(!authorizedBusinessId||requested!==authorizedBusinessId)throw new Error("Café access scope mismatch");
  };
  return {
      hours:async requested=>{
        assertScope(requested);
        const {data,error}=await client.from("locations").select("open_hours").eq("business_id",authorizedBusinessId).order("name",{ascending:true}).limit(1);
        if(error)throw error;
        const value=normalizeOpenHours(data?.[0]?.open_hours);
        const missing=OPEN_HOURS_DAY_KEYS.filter(day=>!value||!Object.hasOwn(value,day)).map(day=>"businessHoursNotSet:"+day);
        return value?{available:true as const,value,quality:{level:missing.length?"medium" as const:"high" as const,missingInputs:missing,estimatedInputs:[],staleInputs:[]}}:
          {available:false as const,value:null,quality:{level:"low" as const,missingInputs:["businessHoursNotSet"],estimatedInputs:[],staleInputs:[]}};
      },
      ingredientCosts:async(requested,asOf,query,limit)=>{
        assertBusiness(requested);
        const {data,error}=await client.from("ingredients").select("id,name,base_unit").eq("business_id",authorizedBusinessId).order("name").limit(501);
        if(error)throw error;
        const filtered=(data??[]).filter(row=>!query||row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        const selected=filtered.slice(0,limit),ids=selected.map(row=>row.id);
        const prices=ids.length?await client.from("ingredient_prices")
          .select("ingredient_id,cost_per_base_unit_micros,effective_from")
          .in("ingredient_id",ids).lte("effective_from",asOf)
          .order("effective_from",{ascending:false}).limit(1001):{data:[],error:null};
        if(prices.error)throw prices.error;
        const latest=new Map<string,{cost_per_base_unit_micros:number;effective_from:string}>();
        for(const price of prices.data??[])if(!latest.has(price.ingredient_id))latest.set(price.ingredient_id,price);
        return {available:true as const,value:{items:selected.map(row=>({
          id:row.id,name:row.name,baseUnit:row.base_unit,
          costPerBaseUnitMicros:latest.get(row.id)?.cost_per_base_unit_micros??null,
          effectiveFrom:latest.get(row.id)?.effective_from??null,
        }))},quality:{level:"high" as const,missingInputs:[
          ...(filtered.length>limit?["ingredientListTruncated"]:[]),
          ...((data??[]).length>500?["ingredientCatalogTruncated"]:[]),
          ...((prices.data??[]).length>1000?["ingredientPriceHistoryTruncated"]:[]),
          ...(selected.some(row=>!latest.has(row.id))?["ingredientPricesMissing"]:[])],
          estimatedInputs:[],staleInputs:[]}};
      },

  };
}

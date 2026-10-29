import "server-only";
import {getToastCheckEvidence} from "@/lib/data/getToastCheckEvidence";
import {getTranslations} from "next-intl/server";
import {readToastDayTrust} from "@/lib/data/toastDayTrust.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromZonedTime } from "date-fns-tz";
import { readDailyFacts } from "@/lib/data/dailyFacts.server";
import type { DailyFacts } from "@/lib/calc";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";
import { rangeExpectedDays } from "./conversations/dateRange";

export type MenuCatalogProduct = { id: string; name: string; category: "drink" | "food";
 active: boolean; priceCents: number|null; baseName?:string|null; sizeLabel?:string|null;
 description?:string|null; menuGroup?:string|null; visibility?:string|null;
 pricingStrategy?:string|null; modifierGroups?:Array<{id:string;name:string;
 minSelections:number|null;maxSelections:number|null;required:boolean;
 options:Array<{name:string;priceCents:number|null}>}> };
export type StaffAttendance = { timecardCount: number; onClockCount: number | null; attendanceTracked: boolean };
const quality = (missingInputs: string[] = []) => ({
  level: (missingInputs.length ? "low" : "high") as "low" | "high",
  missingInputs, estimatedInputs: [] as string[], staleInputs: [] as string[],
});
function missing<T>(reason: string): KnownSlice<T> {
  return { available:false, value:null, quality:quality([reason]) };
}
/** Only bounded invoker-RLS reads, with business identity bound by the session. */
export function supervisorHistoricalReaders(client: SupabaseClient, businessId: string) {
  function assertScope(requested: string) {
    if (!businessId || requested !== businessId) throw new Error("Café access scope mismatch");
  }
  return {
    async salesTrend(id: string, period: CafeStatePeriod): Promise<KnownSlice<DailyFacts[]>> {
      assertScope(id);
      const all = await readDailyFacts(client,id,period.from,period.to);
      const trust=await readToastDayTrust(client,id,period.from,period.to);
      // How Toast days are checked is context, not missing data: it goes in notes.
      const notes=[...trust.notes];
      if(process.env.TOAST_AUTO_IMPORT_ENABLED==="true"){
       try{
        const check=await getToastCheckEvidence(client,id);
        if(check?.compared){const t=await getTranslations("ToastConnect");
         notes.push(t("summaryCompared",{count:check.compared,matched:check.matched}));
        }
       }catch{ /* Context only; the sales numbers do not depend on it. */ }
      }
      const days=all.filter(day=>day.salesDataStatus==="actual");
      if (!days.length) return {available:false,value:null,quality:{...quality([...trust.quality,"noCoveredSalesRows"]),notes}};
      const expected = rangeExpectedDays(period), covered = new Set(days.map(d=>d.date)).size;
      return { available:true, value:days, quality:{...quality([
        ...(covered < expected ? ["salesCoverage:"+covered+"/"+expected] : []),
        ...trust.quality
      ]),notes} };
    },
    async menuCatalog(id: string): Promise<KnownSlice<MenuCatalogProduct[]>> {
      assertScope(id);
      const { data, error } = await client.from("menu_items")
        .select("id,name,base_name,size_label,category,is_active,price_cents,description,menu_group,pos_visibility,pos_pricing_strategy")
        .eq("business_id",id).order("id").limit(501);
      if (error) throw error;
      const items=(data??[]).slice(0,500);
      if(items.length===0)return {available:true,value:[],quality:quality()};
      // All add-on references remain business-scoped and read-only under RLS.
      // A truncated result is labeled incomplete, never silently authoritative.
      const {data:links,error:linksError}=await client.from("menu_item_modifier_groups")
        .select("menu_item_id,pos_group_id,pos_group_name,min_selections,max_selections,required")
        .eq("business_id",id).in("menu_item_id",items.map(item=>item.id))
        .order("menu_item_id").limit(10001);
      if(linksError)throw linksError;
      const groupIds=[...new Set((links??[]).map(link=>link.pos_group_id))];
      const optionRows: Array<{pos_group_id:string|null;name:string;price_cents:number|null;is_active:boolean}>=[];
      for(let start=0;start<groupIds.length;start+=100){
        const {data:options,error:optionError}=await client.from("modifier_recipes")
          .select("pos_group_id,name,price_cents,is_active").eq("business_id",id)
          .in("pos_group_id",groupIds.slice(start,start+100)).order("id").limit(10001);
        if(optionError)throw optionError;
        if((options??[]).length>10000)throw new Error("Menu modifier result truncated");
        optionRows.push(...(options??[]));
      }
      const optionsByGroup=new Map<string,Array<{name:string;priceCents:number|null}>>();
      for(const option of optionRows){
        if(!option.is_active||!option.pos_group_id)continue;
        const list=optionsByGroup.get(option.pos_group_id)??[];
        list.push({name:option.name,priceCents:option.price_cents});
        optionsByGroup.set(option.pos_group_id,list);
      }
      const linksByItem=new Map<string,NonNullable<typeof links>>();
      for(const link of links??[]){
        const list=linksByItem.get(link.menu_item_id)??[];
        list.push(link);linksByItem.set(link.menu_item_id,list);
      }
      return { available:true, value:items.map(row=>({
        id:String(row.id),name:String(row.name).slice(0,120),
        category:row.category==="food"?"food" as const:"drink" as const,
        active:row.is_active!==false,priceCents:row.price_cents===null?null:Number(row.price_cents),
        baseName:row.base_name??null,sizeLabel:row.size_label??null,
        description:row.description??null,menuGroup:row.menu_group??null,
        visibility:row.pos_visibility??null,pricingStrategy:row.pos_pricing_strategy??null,
        modifierGroups:(linksByItem.get(row.id)??[]).map(link=>({
          id:link.pos_group_id,name:link.pos_group_name??"Add-ons",
          minSelections:link.min_selections,maxSelections:link.max_selections,
          required:link.required,options:optionsByGroup.get(link.pos_group_id)??[]
        }))
      })),quality:quality([
        ...((data??[]).length>500?["menuCatalogTruncated"]:[]),
        ...((links??[]).length>10000?["menuModifierLinksTruncated"]:[])
      ]) };
    },
    async staffAttendance(id: string, period: CafeStatePeriod, timezone: string): Promise<KnownSlice<StaffAttendance>> {
      assertScope(id);
      const start = fromZonedTime(period.from+"T00:00:00",timezone).toISOString();
      const end = fromZonedTime(period.to+"T23:59:59.999",timezone).toISOString();
      const [records,people] = await Promise.all([
        client.from("timecards").select("employee_id,clock_in,clock_out,source_type")
          .eq("business_id",id).gte("clock_in",start).lte("clock_in",end).limit(501),
        client.from("employees").select("id").eq("business_id",id).eq("active",true).limit(501),
      ]);
      if (records.error) throw records.error;
      if (people.error) throw people.error;
      if ((people.data ?? []).length>500) return missing("activeTeamTruncated");
      const active = new Set((people.data ?? []).map(p=>p.id));
      // Real recorded timecards remain attendance history even after someone is
      // deactivated or a POS worker is not linked to a roster member. Restrict
      // only the *currently on-clock* count to the authenticated active team.
      // An owner_schedule projection is never recorded attendance.
      const actual = (records.data ?? []).slice(0,500).filter(row =>
        row.source_type !== "owner_schedule");
      const tracked = actual.length > 0;
      return { available:true, value:{
        timecardCount:actual.length,
        onClockCount:tracked ? actual.filter(row=>row.clock_out===null && active.has(row.employee_id)).length : null,
        attendanceTracked:tracked,
      },quality:quality([
        ...((records.data ?? []).length>500?["timecardResultTruncated"]:[]),
        ...(!tracked?["attendanceNotTracked"]:[]),
      ]) };
    },
  };
}

import type {SupabaseClient} from "@supabase/supabase-js";
import {savedValue,type SavedFact} from "@/lib/ownerFacts/inject";

/** The ONE reader of the café's saved location row (café profile screen and the
 * chat's nearby-events tool). RLS-scoped: pass the owner's session client. */
export type CafeLocationRow={name:string|null;open_hours:unknown;address_line1:string|null;address_line2:string|null;
  city:string|null;region:string|null;postal_code:string|null;country_code:string|null};
export const CAFE_LOCATION_COLUMNS="name, open_hours, address_line1, address_line2, city, region, postal_code, country_code";

export async function readPrimaryLocation(db:SupabaseClient,businessId:string):Promise<CafeLocationRow|null>{
  const {data,error}=await db.from("locations").select(CAFE_LOCATION_COLUMNS)
    .eq("business_id",businessId).order("name",{ascending:true}).limit(1).maybeSingle();
  if(error)throw error;
  return (data as CafeLocationRow|null)??null;
}

/** Owner fact key for an address the owner typed in chat (no profile address yet). */
export const CAFE_ADDRESS_FACT="cafe_address";

export type CafeLocation={
  /** One line for search and for the owner, e.g. "12 Main St, Austin, TX 78701, US". */
  label:string;
  city:string|null;region:string|null;postalCode:string|null;countryCode:string|null;
  source:"profile"|"owner";
};
const clean=(s:string|null|undefined)=>{const t=s?.replace(/\s+/gu," ").trim();return t?t.slice(0,120):null;};

/** Profile address first (it has a city or postal code), else the address the
 * owner gave in chat. Null means nobody has told us where the café is. */
export function cafeLocationFrom(row:CafeLocationRow|null,facts:readonly SavedFact[]):CafeLocation|null{
  const city=clean(row?.city),region=clean(row?.region),postal=clean(row?.postal_code);
  const country=clean(row?.country_code)?.toUpperCase()??null;
  if(city||postal){
    const label=[clean(row?.address_line1),city,[region,postal].filter(Boolean).join(" ")||null,country]
      .filter(Boolean).join(", ");
    return {label,city,region,postalCode:postal,countryCode:country&&/^[A-Z]{2}$/u.test(country)?country:null,source:"profile"};
  }
  const typed=savedValue(facts,CAFE_ADDRESS_FACT);
  const text=typeof typed==="string"?clean(typed):null;
  if(text&&text.length>=3)
    return {label:text,city:null,region:null,postalCode:null,
      countryCode:country&&/^[A-Z]{2}$/u.test(country)?country:null,source:"owner"};
  return null;
}

export async function readCafeLocation(db:SupabaseClient,businessId:string,facts:readonly SavedFact[]):Promise<CafeLocation|null>{
  return cafeLocationFrom(await readPrimaryLocation(db,businessId),facts);
}

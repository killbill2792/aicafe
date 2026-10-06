import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { normalizeOpenHours, type OpenHours } from "@/lib/business/openHours";

export type CafeProfileData = {
  name: string;
  timezone: string;
  currency: string;
  openedOn: string;
  locationName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  openHours: OpenHours | null;
};

const EMPTY_PROFILE: CafeProfileData = {
  name: "My café",
  timezone: "America/Los_Angeles",
  currency: "USD",
  openedOn: "",
  locationName: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  countryCode: "",
  openHours: null,
};

export async function getCafeProfile(): Promise<CafeProfileData> {
  if (!isSupabaseConfigured()) return EMPTY_PROFILE;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return EMPTY_PROFILE;

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("business_id, businesses(name, timezone, currency, opened_on, is_demo)")
    .eq("user_id", user.id);
  if (membershipError) throw membershipError;

  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as
      | { name: string; timezone: string; currency: string; opened_on: string | null; is_demo: boolean }
      | { name: string; timezone: string; currency: string; opened_on: string | null; is_demo: boolean }[]
      | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own) return EMPTY_PROFILE;

  const rawBusiness = own.businesses as unknown as
    | { name: string; timezone: string; currency: string; opened_on: string | null; is_demo: boolean }
    | { name: string; timezone: string; currency: string; opened_on: string | null; is_demo: boolean }[];
  const business = Array.isArray(rawBusiness) ? rawBusiness[0] : rawBusiness;

  const { data: location, error: locationError } = await supabase
    .from("locations")
    .select("name, open_hours, address_line1, address_line2, city, region, postal_code, country_code")
    .eq("business_id", own.business_id)
    .order("name", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (locationError) throw locationError;

  return {
    name: business?.name ?? EMPTY_PROFILE.name,
    timezone: business?.timezone ?? EMPTY_PROFILE.timezone,
    currency: business?.currency ?? EMPTY_PROFILE.currency,
    openedOn: business?.opened_on ?? "",
    locationName: location?.name ?? "",
    addressLine1: location?.address_line1 ?? "",
    addressLine2: location?.address_line2 ?? "",
    city: location?.city ?? "",
    region: location?.region ?? "",
    postalCode: location?.postal_code ?? "",
    countryCode: location?.country_code ?? "",
    openHours: normalizeOpenHours(location?.open_hours),
  };
}

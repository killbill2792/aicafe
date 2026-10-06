"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import { OPEN_HOURS_DAY_KEYS, isValidLocalTime, weeklyInputToOpenHours, type WeeklyHoursInput } from "@/lib/business/openHours";

export type ActionResult = { ok: true } | { ok: false; error: string };

const NameSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
});

export async function updateBusinessName(input: z.infer<typeof NameSchema>): Promise<ActionResult> {
  const parsed = NameSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a name." };
  if (parsed.data.businessId === DEMO_BUSINESS_ID) return { ok: false, error: "Can't rename the demo café." };

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: membership } = await supabase
    .from("memberships")
    .select("business_id")
    .eq("user_id", user.id)
    .eq("business_id", parsed.data.businessId)
    .maybeSingle();
  if (!membership) return { ok: false, error: "You don't have access to that business." };

  const { error } = await supabase.from("businesses").update({ name: parsed.data.name }).eq("id", parsed.data.businessId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  revalidatePath("/more");
  revalidatePath("/more/cafe-profile");
  return { ok: true };
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DayHoursSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unset") }),
  z.object({ mode: z.literal("closed") }),
  z.object({ mode: z.literal("open"), open: z.string().regex(TIME_RE), close: z.string().regex(TIME_RE) }),
]);
const WeeklyHoursSchema = z.object({
  sun: DayHoursSchema,
  mon: DayHoursSchema,
  tue: DayHoursSchema,
  wed: DayHoursSchema,
  thu: DayHoursSchema,
  fri: DayHoursSchema,
  sat: DayHoursSchema,
});
const CafeProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: z.string().trim().min(1).max(100),
  currency: z.string().trim().length(3),
  openedOn: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  locationName: z.string().trim().max(80),
  addressLine1: z.string().trim().max(120),
  addressLine2: z.string().trim().max(120),
  city: z.string().trim().max(80),
  region: z.string().trim().max(80),
  postalCode: z.string().trim().max(24),
  countryCode: z.string().trim().max(2).refine((value) => value === "" || value.length === 2),
  hours: WeeklyHoursSchema,
});

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function updateCafeProfile(input: unknown): Promise<ActionResult> {
  const parsed = CafeProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the café details and hours." };

  const data = parsed.data;
  if (!validTimezone(data.timezone)) return { ok: false, error: "Enter a valid timezone, such as America/Los_Angeles." };
  for (const key of OPEN_HOURS_DAY_KEYS) {
    const day = data.hours[key];
    if (day.mode !== "open") continue;
    if (!isValidLocalTime(day.open) || !isValidLocalTime(day.close) || day.open === day.close) {
      return { ok: false, error: "Check the opening and closing times." };
    }
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("business_id, businesses(is_demo)")
    .eq("user_id", user.id);
  if (membershipError) return { ok: false, error: membershipError.message };

  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own || own.business_id === DEMO_BUSINESS_ID) return { ok: false, error: "Set up your own café first." };

  const businessUpdate = await supabase
    .from("businesses")
    .update({
      name: data.name,
      timezone: data.timezone,
      currency: data.currency.toUpperCase(),
      opened_on: data.openedOn || null,
    })
    .eq("id", own.business_id);
  if (businessUpdate.error) return { ok: false, error: businessUpdate.error.message };

  const { data: location, error: locationLookupError } = await supabase
    .from("locations")
    .select("id")
    .eq("business_id", own.business_id)
    .order("name", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (locationLookupError) return { ok: false, error: locationLookupError.message };

  const locationRow = {
    business_id: own.business_id,
    name: data.locationName || "Main location",
    open_hours: weeklyInputToOpenHours(data.hours as WeeklyHoursInput),
    address_line1: nullable(data.addressLine1),
    address_line2: nullable(data.addressLine2),
    city: nullable(data.city),
    region: nullable(data.region),
    postal_code: nullable(data.postalCode),
    country_code: nullable(data.countryCode.toUpperCase()),
  };

  const locationWrite = location
    ? await supabase.from("locations").update(locationRow).eq("id", location.id).eq("business_id", own.business_id)
    : await supabase.from("locations").insert(locationRow);
  if (locationWrite.error) return { ok: false, error: locationWrite.error.message };

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  revalidatePath("/staff");
  revalidatePath("/more");
  revalidatePath("/more/cafe-profile");
  return { ok: true };
}

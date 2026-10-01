import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

// Kept so old links/bookmarks to the retired "manage menu" screen still land somewhere real,
// instead of 404ing — all of its functionality now lives on /menu/new and /menu/[itemId].
export const dynamic = "force-dynamic";

export default async function ManageMenuRedirect({ searchParams }: { searchParams: Promise<{ add?: string; item?: string }> }) {
  const [query, locale] = await Promise.all([searchParams, getLocale()]);
  if (query.add === "1") redirect(`/${locale}/menu/new`);
  if (query.item) redirect(`/${locale}/menu/${query.item}`);
  redirect(`/${locale}/menu`);
}

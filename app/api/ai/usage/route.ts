export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Usage events remain in the private Supabase ledger. This legacy owner-facing
 * read endpoint intentionally discloses no token, model, provider or cost data. */
export async function GET() {
  return Response.json({ error: "not_found" }, { status: 404 });
}

import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { refreshSupabaseSession } from "./lib/supabase/middleware";

const intlMiddleware = createMiddleware(routing);

export default async function proxy(request: NextRequest) {
  // Admin has its own English-only root layout; never locale-rewrite /admin.
  const response = request.nextUrl.pathname.startsWith("/admin")
    ? NextResponse.next() : intlMiddleware(request);
  return refreshSupabaseSession(request, response);
}

export const config = {
  // Match all pathnames except for
  // - … if they start with `/api`, `/_next` or `/_vercel`
  // - … the ones containing a dot (e.g. `favicon.ico`, `manifest.json`, `sw.js`)
  matcher: "/((?!api|auth|_next|_vercel|.*\\..*).*)",
};

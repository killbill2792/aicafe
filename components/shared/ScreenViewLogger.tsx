"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { logScreenView } from "@/lib/actions/analytics";

/** Fires a best-effort screen-view log on every route change. Mounted once in the locale layout. */
export default function ScreenViewLogger() {
  const pathname = usePathname();

  useEffect(() => {
    logScreenView(pathname).catch(() => {});
  }, [pathname]);

  return null;
}

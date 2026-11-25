import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import {redirect} from "next/navigation";
import {getOptionalAuthenticatedUser} from "@/lib/auth/requireUser";
import {isLinkedStaffUser} from "@/lib/staffCommunication/identity.server";
import { parseModeCookie, parseThemeCookie } from "@/app/themes";
import { parseTextSizeCookie } from "@/app/textSize";
import { routing, getDirection } from "@/i18n/routing";
import TabBar from "@/components/TabBar";
import SideNav from "@/components/SideNav";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import { getActiveCafeName } from "@/lib/data/getActiveCafeName";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ExpenseIconDefs from "@/components/icons/ExpenseIconDefs";
import ScreenViewLogger from "@/components/shared/ScreenViewLogger";
import NavigationTiming from "@/components/shared/NavigationTiming";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("LocaleLayout");
  return {
    title: t("title"),
    description: "How much money you actually kept, and why.",
    manifest: "/manifest.json",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: t("title"),
    },
  };
}

export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#F4F6F5" }, { media: "(prefers-color-scheme: dark)", color: "#0E1413" }],
  width: "device-width",
  initialScale: 1,
};

// The navigation is interactive while its authorized café label loads.
async function ActiveCafeNavigation() {
  const activeCafeName = await getActiveCafeName();
  return <SideNav cafeName={activeCafeName} languageSwitch={<LanguageSwitch href="/" compact />} />;
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: paramLocale } = await params;
  if (!hasLocale(routing.locales, paramLocale)) {
    notFound();
  }

  // Guard before the locale shell begins streaming: linked employees must
  // never receive an owner-layout response, including onboarding or pricing.
  const signedIn=await getOptionalAuthenticatedUser();
  if(signedIn&&await isLinkedStaffUser(signedIn.id))redirect("/crew");

  const locale = await getLocale();
  const dir = getDirection(locale);
  const cookieStore = await cookies();
  const theme = parseThemeCookie(cookieStore.get("cp_theme")?.value);
  const mode = parseModeCookie(cookieStore.get("cp_mode")?.value);
  const textSize = parseTextSizeCookie(cookieStore.get("cp_text")?.value);

  return (
    <html
      lang={locale}
      dir={dir}
      data-theme={theme}
      data-mode={mode}
      data-text-size={textSize}
      className="h-full"
    >
      <body
        className={`flex h-full min-h-screen flex-col ${locale === "ar" ? "font-arabic" : "font-body"}`}
      >
        <NextIntlClientProvider>
          <ExpenseIconDefs />
          <ScreenViewLogger />
          <NavigationTiming />
          <div className="flex min-h-screen w-full flex-1">
            <Suspense fallback={<SideNav cafeName="" languageSwitch={<LanguageSwitch href="/" compact />} />}>
              <ActiveCafeNavigation />
            </Suspense>
            <div className="app-page-content w-full min-w-0 flex-1 pb-24 md:pb-10">{children}</div>
          </div>
          <TabBar />
          <ServiceWorkerRegister />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

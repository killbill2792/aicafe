import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { parseModeCookie, parseThemeCookie } from "@/app/themes";
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

// Self-hosted (OFL) so builds never download fonts from Google: the same files and
// subsets next/font/google used (Jakarta and Inter latin, IBM Plex Sans Arabic arabic).
const jakarta = localFont({
  src: "../fonts/plus-jakarta-sans-latin-wght.woff2", weight: "500 800",
  variable: "--font-jakarta", display: "swap",
});
const inter = localFont({
  src: "../fonts/inter-latin-wght.woff2", weight: "400 700",
  variable: "--font-inter", display: "swap",
});

const ibmPlexSansArabic = localFont({
  src: [
    { path: "../fonts/ibm-plex-sans-arabic-arabic-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-sans-arabic-arabic-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/ibm-plex-sans-arabic-arabic-600.woff2", weight: "600", style: "normal" },
    { path: "../fonts/ibm-plex-sans-arabic-arabic-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-ibm-plex-arabic", display: "swap",
});

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

  const locale = await getLocale();
  const dir = getDirection(locale);
  const activeCafeName = await getActiveCafeName();
  const cookieStore = await cookies();
  const theme = parseThemeCookie(cookieStore.get("cp_theme")?.value);
  const mode = parseModeCookie(cookieStore.get("cp_mode")?.value);

  return (
    <html
      lang={locale}
      dir={dir}
      data-theme={theme}
      data-mode={mode}
      className={`h-full ${jakarta.variable} ${inter.variable} ${ibmPlexSansArabic.variable}`}
    >
      <body
        className={`flex h-full min-h-screen flex-col ${locale === "ar" ? "font-arabic" : "font-body"}`}
      >
        <NextIntlClientProvider>
          <ExpenseIconDefs />
          <ScreenViewLogger />
          <NavigationTiming />
          <div className="flex min-h-screen w-full flex-1">
            <SideNav cafeName={activeCafeName} languageSwitch={<LanguageSwitch href="/" compact />} />
            <div className="w-full min-w-0 flex-1 pb-24 md:pb-10">{children}</div>
          </div>
          <TabBar />
          <ServiceWorkerRegister />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

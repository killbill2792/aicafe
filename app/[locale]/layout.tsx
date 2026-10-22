import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Inter, IBM_Plex_Sans_Arabic } from "next/font/google";
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
import "../globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-jakarta" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-inter" });

const ibmPlexSansArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-arabic",
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

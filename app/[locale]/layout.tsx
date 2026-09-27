import type { Metadata, Viewport } from "next";
import { Fraunces, Figtree, IBM_Plex_Sans_Arabic } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { routing, getDirection } from "@/i18n/routing";
import TabBar from "@/components/TabBar";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ExpenseIconDefs from "@/components/icons/ExpenseIconDefs";
import ScreenViewLogger from "@/components/shared/ScreenViewLogger";
import "../globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
});

const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
});

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
  themeColor: "#1E6B4B",
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

  return (
    <html
      lang={locale}
      dir={dir}
      className={`h-full ${fraunces.variable} ${figtree.variable} ${ibmPlexSansArabic.variable}`}
    >
      <body
        className={`flex h-full min-h-screen flex-col ${locale === "ar" ? "font-arabic" : "font-body"}`}
      >
        <NextIntlClientProvider>
          <ExpenseIconDefs />
          <ScreenViewLogger />
          <div className="mx-auto w-full max-w-app flex-1 pb-24">
            {children}
          </div>
          <TabBar />
          <ServiceWorkerRegister />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

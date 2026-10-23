import {getTranslations,getLocale} from "next-intl/server";
import {formatCents} from "@/lib/calc/money";
import {requireUser} from "@/lib/auth/requireUser";
import {pricingPlans} from "@/lib/access/plans";
import {requireOwnerAccessScope} from "@/lib/access/access.server";
import RedeemCodeForm from "@/components/access/RedeemCodeForm";
import PageShell from "@/components/shared/PageShell";
export const dynamic="force-dynamic";
export default async function PricingPage(){
 const user=await requireUser();
 const t=await getTranslations("FreeAccess");
 const locale=await getLocale();
 const displayLocale=locale==="es"?"es-ES":locale==="ar"?"ar-EG":"en-US";
 let access:null|Awaited<ReturnType<typeof requireOwnerAccessScope>>=null;
 if(user){try{access=await requireOwnerAccessScope();}catch{/* not an owner yet */}}
 return <PageShell className="mx-auto max-w-3xl space-y-5 px-4 py-6">
  <h1 className="text-3xl font-bold">{t("pricing")}</h1>
  <p>{t("noPayments")}</p>
  <div className="grid gap-4 sm:grid-cols-2">{pricingPlans.map(p=><article key={p.id} className="rounded-xl border bg-card p-5">
   <h2 className="text-xl font-bold">{t(p.id)}</h2><p className="my-3 text-2xl font-bold">{formatCents(p.monthlyCents,displayLocale)}<span className="text-[17px] font-normal"> {t("perMonth")}</span></p>
   <ul className="list-inside list-disc space-y-1 text-[17px]">{p.features.map(f=><li key={f}>{t(f)}</li>)}</ul>
  </article>)}</div>
  {access&&<section className="rounded-xl border bg-card p-5">
   <h2 className="text-xl font-bold">{t("accessTitle")}</h2>
   <p>{access.access.mode==="grandfathered"?t("fullAccess"):access.access.active?t("freeUntil",{date:access.access.accessEnd??""}):t("expired")}</p>
   {access.access.remind&&<p role="status" className="mt-2">{t("renewSoon",{date:access.access.accessEnd??""})}</p>}
   <RedeemCodeForm copy={{label:t("haveCode"),placeholder:t("codePlaceholder"),submit:t("redeem"),success:t("redeemed"),error:t("redeemError"),invalid:t("redeemInvalid"),expiredCode:t("redeemExpired"),full:t("redeemFull"),rateLimited:t("redeemRateLimited"),pausedCafe:t("redeemPaused"),alreadyRedeemed:t("redeemAlreadyUsed")}}/>
  </section>}
 </PageShell>;
}

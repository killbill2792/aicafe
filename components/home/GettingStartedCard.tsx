import { ChevronRight, CreditCard, FileSpreadsheet, Receipt, Users } from "lucide-react";
import { Link } from "@/i18n/navigation";

export default function GettingStartedCard({
  labels,
}: {
  labels: {
    title: string;
    body: string;
    connectRegister: string;
    addBills: string;
    addStaff: string;
    uploadSales: string;
  };
}) {
  const links = [
    { href: "/onboarding", Icon: CreditCard, label: labels.connectRegister },
    { href: "/more/uploads/sales", Icon: FileSpreadsheet, label: labels.uploadSales },
    { href: "/more/bills", Icon: Receipt, label: labels.addBills },
    { href: "/more/manage-staff", Icon: Users, label: labels.addStaff },
  ];

  return (
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-ink">{labels.title}</h2>
        <p className="text-[15px] leading-snug text-ink-muted">{labels.body}</p>
      </div>
      <div className="flex flex-col rounded-2xl bg-paper px-1">
        {links.map(({ href, Icon, label }) => (
          <Link key={href} href={href} className="flex items-center gap-3 border-b border-[#EFE7DB] px-2.5 py-3.5 text-ink no-underline last:border-b-0">
            <Icon aria-hidden="true" size={20} className="shrink-0 text-ink-muted" />
            <span className="flex-1 text-[15px] font-semibold">{label}</span>
            <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-ink-muted rtl:rotate-180" />
          </Link>
        ))}
      </div>
    </section>
  );
}

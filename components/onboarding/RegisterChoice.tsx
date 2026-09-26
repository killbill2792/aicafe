import { Coffee, CreditCard, FileSpreadsheet, Store } from "lucide-react";
import { Link } from "@/i18n/navigation";

export default function RegisterChoice({
  locale,
  squareConfigured,
  labels,
}: {
  locale: string;
  squareConfigured: boolean;
  labels: {
    connectSquare: string;
    squareNotConfigured: string;
    useToast: string;
    useClover: string;
    useOther: string;
    csvHint: string;
    skip: string;
  };
}) {
  return (
    <div className="flex flex-col gap-3">
      <a
        href={squareConfigured ? `/api/pos/square/connect?locale=${locale}` : "#"}
        aria-disabled={!squareConfigured}
        className={`flex h-16 items-center gap-3 rounded-full px-5 font-bold text-paper ${squareConfigured ? "bg-ink" : "pointer-events-none bg-ink/40"}`}
      >
        <CreditCard aria-hidden="true" size={22} />
        {labels.connectSquare}
      </a>
      {!squareConfigured && <p className="px-2 text-sm text-warn">{labels.squareNotConfigured}</p>}

      <div className="grid grid-cols-3 gap-2">
        <RegisterTile Icon={Store} label={labels.useToast} />
        <RegisterTile Icon={Coffee} label={labels.useClover} />
        <RegisterTile Icon={FileSpreadsheet} label={labels.useOther} />
      </div>
      <p className="px-2 text-sm text-ink-muted">{labels.csvHint}</p>

      <Link href="/onboarding?step=2" className="mt-2 flex h-14 items-center justify-center rounded-full border border-line text-base font-bold text-ink">
        {labels.skip}
      </Link>
    </div>
  );
}

function RegisterTile({ Icon, label }: { Icon: typeof Store; label: string }) {
  return (
    <Link href="/more/uploads" className="flex flex-col items-center gap-2 rounded-2xl bg-card p-4 text-center text-ink no-underline">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-good-tint text-good">
        <Icon aria-hidden="true" size={20} />
      </span>
      <span className="text-sm font-semibold leading-tight">{label}</span>
    </Link>
  );
}

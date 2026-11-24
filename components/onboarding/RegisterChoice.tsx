import {Store} from "lucide-react";
import {Link} from "@/i18n/navigation";

/** First login goes directly to the owner's Toast connection; no shared
 * sample café, CSV/switcher or five-step prerequisite wizard. */
export default function RegisterChoice({
  toastEnabled=false,labels,
}:{
  toastEnabled?:boolean;
  labels:{useToast:string;unavailable:string};
}){
  return <div className="flex flex-col gap-4">
    {toastEnabled?
      <Link href="/more/toast" className="flex min-h-16 items-center justify-center gap-3 rounded-full bg-accent px-5 text-lg font-bold text-on-accent">
        <Store size={22} aria-hidden="true"/>{labels.useToast}
      </Link>:
      <p className="rounded-2xl bg-warn-tint p-4 text-base text-warn">{labels.unavailable}</p>}
  </div>;
}

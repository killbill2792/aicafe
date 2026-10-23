"use client";
import { useEffect, useState } from "react";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type { TeamRule } from "@/lib/ai/policies/contracts";

type Locale = "en" | "es" | "ar";
const dict = { en, es, ar } as const;

/**
 * "Remember this?" card for a fact the assistant proposed. Nothing is saved
 * until the owner taps Remember; the fact is a team rule draft underneath, so
 * it also shows (and can be paused) on the team rules screen.
 */
export default function MemoryCard({ ruleId, locale }: { ruleId: string; locale: Locale }) {
  const copy = dict[locale].MemoryCard;
  const [rule, setRule] = useState<TeamRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"load" | "save" | "conflict" | null>(null);
  const endpoint = "/api/ai/rules/" + encodeURIComponent(ruleId);

  useEffect(() => {
    let alive = true;
    void fetch(endpoint, { cache: "no-store", credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw Error(); return r.json(); })
      .then((data: { rule: TeamRule }) => { if (alive) setRule(data.rule); })
      .catch(() => { if (alive) setError("load"); });
    return () => { alive = false; };
  }, [endpoint]);

  const decide = async (decision: "approve" | "reject") => {
    if (!rule || busy || rule.status !== "draft") return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: rule.version, decision }),
      });
      if (response.status === 409) { setError("conflict"); return; }
      if (!response.ok) { setError("save"); return; }
      const body = await response.json() as { rule: TeamRule };
      setRule(body.rule);
    } catch { setError("save"); }
    finally { setBusy(false); }
  };

  if (!rule) return error ? <p role="alert" className="text-[15px] text-neg">{copy.error}</p>
    : <p role="status" className="text-[15px] text-ink-muted">{copy.loading}</p>;
  const agents = copy.agents as Record<string, string>;
  const status = rule.status === "active" ? copy.saved : rule.status === "rejected" ? copy.notSaved
    : rule.status === "paused" ? copy.paused : null;
  const button = "min-h-12 min-w-12 rounded-xl px-4 text-[17px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
  return <section dir={locale === "ar" ? "rtl" : "ltr"} aria-label={copy.title}
    className="w-full min-w-0 max-w-2xl rounded-[22px] border border-line bg-surface p-4 text-ink shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[15px] font-semibold text-ink-muted">{copy.title}</p>
      {status && <span role="status" className="rounded-full bg-surface2 px-3 py-1 text-sm font-bold">{status}</span>}
    </div>
    <p className="mt-2 break-words text-[17px] font-semibold">{rule.instruction}</p>
    <p className="mt-1 text-[14px] text-ink-muted">{agents[rule.agentId] ?? agents.supervisor}</p>
    {rule.status === "draft" && <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={busy} className={button + " bg-accent text-on-accent"}
        onClick={() => void decide("approve")}>{copy.approve}</button>
      <button type="button" disabled={busy} className={button + " border border-line"}
        onClick={() => void decide("reject")}>{copy.reject}</button>
    </div>}
    {error && error !== "load" && <p role="alert" className="mt-2 text-neg">
      {error === "conflict" ? copy.conflict : copy.error}</p>}
  </section>;
}

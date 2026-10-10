"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { RuleAgent, RuleDecision, RuleEvent, RulesPage, TeamRule } from "@/lib/ai/policies/contracts";
import { POLICY_AGENTS } from "@/lib/ai/policies/contracts";

export type TeamRulesCopy = {
  agent: string; instruction: string; instructionHint: string;
  saveDraft: string; rules: string; audit: string; emptyRules: string;
  emptyAudit: string; approve: string; reject: string; pause: string;
  resume: string; draft: string; active: string; paused: string; rejected: string;
  warning: string; loading: string; saving: string; error: string; conflict: string;
  loadMore: string; by: string; created: string; to: string;
  supervisor: string; alex: string; olivia: string; maya: string; leo: string;
};

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const reason = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(response.status === 409 ? "conflict" : reason.error ?? "error");
  }
  return response.json() as Promise<T>;
}

const surface = "rounded-2xl border border-[#D8C8B5] bg-card p-4 md:p-5";
const field = "min-h-12 w-full rounded-xl border border-[#B9A995] bg-white px-3 text-[17px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
const button = "min-h-12 rounded-full px-4 text-[17px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50";

export default function TeamRulesManager({ copy }: { copy: TeamRulesCopy }) {
  const [agentId, setAgentId] = useState<RuleAgent>("supervisor");
  const [instruction, setInstruction] = useState("");
  const [rules, setRules] = useState<TeamRule[]>([]);
  const [events, setEvents] = useState<RuleEvent[]>([]);
  const [nextRuleOffset, setNextRuleOffset] = useState<number | null>(null);
  const [nextAuditOffset, setNextAuditOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"error" | "conflict" | null>(null);

  const load = useCallback(async () => {
    const [rulePage, auditPage] = await Promise.all([
      fetch("/api/ai/rules", { cache: "no-store" }).then(readResponse<RulesPage<TeamRule>>),
      fetch("/api/ai/rules/audit", { cache: "no-store" }).then(readResponse<RulesPage<RuleEvent>>),
    ]);
    setRules(rulePage.items);
    setNextRuleOffset(rulePage.nextOffset);
    setEvents(auditPage.items);
    setNextAuditOffset(auditPage.nextOffset);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch(() => { if (!cancelled) setError("error"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || instruction.trim().length < 5) return;
    setBusy(true); setError(null);
    try {
      await readResponse(await fetch("/api/ai/rules", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, instruction: instruction.trim() }),
      }));
      setInstruction("");
      await load();
    } catch (issue) {
      setError(issue instanceof Error && issue.message === "conflict" ? "conflict" : "error");
    } finally { setBusy(false); }
  }

  async function review(rule: TeamRule, decision: RuleDecision) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await readResponse(await fetch("/api/ai/rules/" + encodeURIComponent(rule.id), {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: rule.version, decision }),
      }));
      await load();
    } catch (issue) {
      setError(issue instanceof Error && issue.message === "conflict" ? "conflict" : "error");
    } finally { setBusy(false); }
  }

  async function loadOlder(kind: "rules" | "audit") {
    const offset = kind === "rules" ? nextRuleOffset : nextAuditOffset;
    if (offset === null || busy) return;
    setBusy(true); setError(null);
    try {
      if (kind === "rules") {
        const page = await readResponse<RulesPage<TeamRule>>(
          await fetch("/api/ai/rules?offset=" + offset, { cache: "no-store" }));
        setRules((old) => [...old, ...page.items.filter((item) => !old.some((r) => r.id === item.id))]);
        setNextRuleOffset(page.nextOffset);
      } else {
        const page = await readResponse<RulesPage<RuleEvent>>(
          await fetch("/api/ai/rules/audit?offset=" + offset, { cache: "no-store" }));
        setEvents((old) => [...old, ...page.items.filter((item) => !old.some((e) => e.id === item.id))]);
        setNextAuditOffset(page.nextOffset);
      }
    } catch { setError("error"); }
    finally { setBusy(false); }
  }

  const agentName = (agent: RuleAgent) => copy[agent];
  const statusLabel = (rule: TeamRule) => copy[rule.status];
  return <div className="flex flex-col gap-4">
    <p className="rounded-2xl border border-[#D8C8B5] bg-[#FFF4E0] p-4 text-[17px] leading-relaxed text-ink">{copy.warning}</p>
    <form onSubmit={(event) => void create(event)} className={surface}>
      <div className="flex flex-col gap-3">
        <label htmlFor="policy-agent" className="text-[17px] font-bold text-ink">{copy.agent}</label>
        <select id="policy-agent" className={field} value={agentId} disabled={busy}
          onChange={(event) => setAgentId(event.target.value as RuleAgent)}>
          {POLICY_AGENTS.map((agent) => <option key={agent} value={agent}>{agentName(agent)}</option>)}
        </select>
        <label htmlFor="policy-instruction" className="text-[17px] font-bold text-ink">{copy.instruction}</label>
        <textarea id="policy-instruction" className={field + " min-h-32 py-3"} value={instruction}
          maxLength={1000} minLength={5} required disabled={busy}
          placeholder={copy.instructionHint} onChange={(event) => setInstruction(event.target.value)}/>
        <button type="submit" disabled={busy || instruction.trim().length < 5}
          className={button + " bg-ink text-paper"}>{busy ? copy.saving : copy.saveDraft}</button>
      </div>
    </form>

    <section className={surface} aria-labelledby="policy-rules-heading">
      <h2 id="policy-rules-heading" className="font-headline text-2xl font-bold text-ink">{copy.rules}</h2>
      {loading && <p className="mt-3 text-[17px] text-ink-muted">{copy.loading}</p>}
      {!loading && rules.length === 0 && <p className="mt-3 text-[17px] text-ink-muted">{copy.emptyRules}</p>}
      <div className="mt-3 flex flex-col gap-3">
        {rules.map((rule) => <article key={rule.id} className="rounded-2xl border border-[#D8C8B5] bg-paper p-4">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-[17px] text-ink">{agentName(rule.agentId)}</strong>
            <span className="rounded-full bg-[#E8E0D4] px-3 py-1 text-[15px] font-semibold text-ink">{statusLabel(rule)}</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-[17px] leading-relaxed text-ink">{rule.instruction}</p>
          <p className="mt-2 text-sm text-ink-muted">{copy.created}: {rule.createdAt.slice(0, 10)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {rule.status === "draft" && <>
              <button type="button" disabled={busy} onClick={() => void review(rule, "approve")}
                className={button + " bg-ink text-paper"}>{copy.approve}</button>
              <button type="button" disabled={busy} onClick={() => void review(rule, "reject")}
                className={button + " border border-ink text-ink"}>{copy.reject}</button>
            </>}
            {rule.status === "active" && <button type="button" disabled={busy}
              onClick={() => void review(rule, "pause")}
              className={button + " border border-ink text-ink"}>{copy.pause}</button>}
            {rule.status === "paused" && <button type="button" disabled={busy}
              onClick={() => void review(rule, "resume")}
              className={button + " bg-ink text-paper"}>{copy.resume}</button>}
          </div>
        </article>)}
      </div>
      {nextRuleOffset !== null && <button type="button" onClick={() => void loadOlder("rules")}
        disabled={busy} className={button + " mt-4 w-full border border-ink text-ink"}>{copy.loadMore}</button>}
    </section>

    <section className={surface} aria-labelledby="policy-audit-heading">
      <h2 id="policy-audit-heading" className="font-headline text-2xl font-bold text-ink">{copy.audit}</h2>
      {!loading && events.length === 0 && <p className="mt-3 text-[17px] text-ink-muted">{copy.emptyAudit}</p>}
      <ol className="mt-3 flex flex-col gap-3">
        {events.map((event) => <li key={event.id} className="rounded-xl border border-[#D8C8B5] p-3">
          <strong className="text-[17px] text-ink">{agentName(event.agentId)} · {copy[event.newStatus]}</strong>
          <p className="mt-1 break-words text-[17px] text-ink">{event.instruction}</p>
          <p className="mt-1 text-sm text-ink-muted">
            {event.previousStatus ? copy[event.previousStatus] + " → " : ""}
            {copy[event.newStatus]} · {event.createdAt.slice(0, 10)} · {copy.by} {event.actorUserId.slice(0, 8)}
          </p>
        </li>)}
      </ol>
      {nextAuditOffset !== null && <button type="button" onClick={() => void loadOlder("audit")}
        disabled={busy} className={button + " mt-4 w-full border border-ink text-ink"}>{copy.loadMore}</button>}
    </section>
    <div role="status" aria-live="polite" className="text-[17px] font-semibold text-ink">
      {error === "conflict" ? copy.conflict : error ? copy.error : ""}
    </div>
  </div>;
}

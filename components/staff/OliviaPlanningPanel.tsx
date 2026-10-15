"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { previewOliviaWeek, saveOliviaWeekDraft, readOliviaPlanHistory } from "@/lib/actions/oliviaPlanning";
import type { PlannerResult, PlannerScenario } from "@/lib/calc/scheduling/plannerTypes";

function mondayOf(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Owner-facing proposal workspace only. No approval or publishing controls
 * until backend can independently revalidate and transactionally commit.
 */
export default function OliviaPlanningPanel({ today }: { today: string }) {
  const t = useTranslations("OliviaPlanning");
  const [week, setWeek] = useState(() => mondayOf(today));
  const [result, setResult] = useState<PlannerResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [objective, setObjective] = useState<PlannerScenario["objective"]>("balanced");
  const [currentRevision, setCurrentRevision] = useState(0);
  const [publishedRevision, setPublishedRevision] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<{ revision: number; status: string }>>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  const scenario = result?.scenarios.find(s => s.objective === objective);

  function loadHistory(selectedWeek: string) {
    return readOliviaPlanHistory({ week: selectedWeek }).then(r => {
      if (r.ok) {
        setCurrentRevision(r.currentRevision);
        setPublishedRevision(r.publishedRevision);
        setHistory(r.revisions);
      } else {
        setError(r.error);
      }
    });
  }

  function preview() {
    setError(""); setNotice(""); setResult(null);
    startTransition(async () => {
      const response = await previewOliviaWeek({ week });
      if (!response.ok) { setError(response.error); return; }
      setResult(response.plan);
      setWarnings(response.warnings);
      await loadHistory(week);
    });
  }
  function save() {
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await saveOliviaWeekDraft({
        week, objective, expectedRevision: currentRevision,
        requestKey: crypto.randomUUID(),
      });
      if (!response.ok) { setError(response.error); return; }
      setNotice(t("savedRevision", { revision: response.revision }));
      await loadHistory(week);
    });
  }

  return <section className="flex flex-col gap-4 rounded-card-lg bg-card p-[18px]"
    aria-label={t("title")}>
    <div>
      <h2 className="text-lg font-bold">{t("title")}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t("draftOnly")}</p>
    </div>
    <label className="flex flex-col gap-1 text-base font-semibold">
      {t("week")}
      <input type="date" value={week} onChange={e => {
        setWeek(mondayOf(e.target.value)); setResult(null); setHistory([]);
        setCurrentRevision(0); setPublishedRevision(null); setError(""); setNotice("");
      }} className="h-12 rounded-xl border border-line bg-paper px-3" />
    </label>
    <button type="button" disabled={pending} onClick={preview}
      className="min-h-12 rounded-full bg-ink px-4 font-bold text-paper disabled:opacity-50">
      {t("generate")}
    </button>
    {error && <p role="alert" className="text-base text-warn">{error}</p>}
    {notice && <p role="status" className="text-base">{notice}</p>}
    {result && <>
      <p className="text-sm text-ink-muted">{t("status")}: {result.status}</p>
      <label className="flex flex-col gap-1 font-semibold">{t("scenario")}
        <select value={objective} onChange={e =>
          setObjective(e.target.value as PlannerScenario["objective"])}
          className="min-h-12 rounded-xl border border-line bg-paper px-3">
          <option value="balanced">{t("balanced")}</option>
          <option value="cash">{t("cash")}</option>
          <option value="owner_time">{t("ownerTime")}</option>
        </select>
      </label>
      {scenario && <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-line p-3 text-sm">
          <p>{t("coverage")}: {scenario.completeCoverage ? t("complete") : t("incomplete")}</p>
          <p>{t("ownerMinutes")}: {scenario.ownerMinutes}</p>
          <p>{t("cashCost")}: {scenario.cost.cashWagesCents === null ?
            t("unknown") : (scenario.cost.cashWagesCents / 100).toFixed(2)}</p>
          <p>{t("legalReview")}: {scenario.legalReview === "verified_profile" ?
            t("verified") : t("unverified")}</p>
        </div>
        <h3 className="font-bold">{t("assignments")}</h3>
        {scenario.shifts.length === 0 && <p>{t("noAssignments")}</p>}
        {scenario.shifts.map((shift, i) => <div key={i}
          className="rounded-xl border border-line px-3 py-2 text-sm">
          <p className="font-semibold">{shift.employeeId}</p>
          <p>{shift.startAt} — {shift.endAt}</p>
          <p>{t("location")}: {shift.locationId}</p>
          <p>{t("paidMinutes")}: {shift.paidMinutes}</p>
        </div>)}
        <h3 className="font-bold">{t("gaps")}</h3>
        {scenario.gaps.length === 0 && <p>{t("noGaps")}</p>}
        {scenario.gaps.map((gap, i) => <p key={i} className="text-sm text-warn">
          {gap.startAt} — {gap.endAt}: {gap.reason} ({gap.missingHeadcount})
        </p>)}
        <button type="button" disabled={pending || !scenario.hardConstraintsSatisfied}
          onClick={save}
          className="min-h-12 rounded-full border border-ink px-4 font-bold disabled:opacity-50">
          {t("saveDraft")}
        </button>
      </div>}
    </>}
    {warnings.length > 0 && <div role="status" className="text-sm text-ink-muted">
      <h3 className="font-bold">{t("warnings")}</h3>
      <ul className="list-disc space-y-1 ps-5">{warnings.map((warning, i) =>
        <li key={i}>{warning}</li>)}</ul>
    </div>}
    <div className="border-t border-line pt-3">
      <button type="button" onClick={() => startTransition(() => { void loadHistory(week); })}
        disabled={pending} className="min-h-12 font-semibold underline">
        {t("refreshHistory")}
      </button>
      <p className="text-sm">{t("officialVersion")}: {publishedRevision ?? t("none")}</p>
      {history.map(item => <p key={item.revision} className="text-sm">
        V{item.revision} · {item.status}
      </p>)}
    </div>
  </section>;
}

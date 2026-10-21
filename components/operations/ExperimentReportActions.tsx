"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { acknowledgeExperimentReport } from "@/lib/actions/operatingTasks";

export default function ExperimentReportActions({ taskId, acknowledgeLabel, errorLabel }: {
  taskId: string; acknowledgeLabel: string; errorLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const router = useRouter();

  const acknowledge = () => startTransition(async () => {
    setError(false);
    try {
      const result = await acknowledgeExperimentReport({ taskId });
      if (result.ok) router.refresh();
      else setError(true);
    } catch {
      setError(true);
    }
  });

  return <div className="mt-2">
    <button type="button" disabled={pending} onClick={acknowledge}
      className="min-h-12 w-full rounded-full border border-ink px-4 text-[17px] font-bold text-ink disabled:opacity-50">
      {acknowledgeLabel}
    </button>
    {error && <p role="alert" className="mt-2 text-sm font-semibold text-warn">{errorLabel}</p>}
  </div>;
}

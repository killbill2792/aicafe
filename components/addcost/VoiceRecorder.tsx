"use client";

import { useRef, useState, useTransition } from "react";
import { Mic } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { Link } from "@/i18n/navigation";
import { reviewVoiceExpense } from "@/lib/actions/voiceReview";
import { addManualExpense } from "@/lib/actions/expenses";
import type { VoiceExpenseResult } from "@/lib/ai/prompts/voiceExpense";
import type { ExpenseCategoryCode } from "@/lib/constants";
import { formatCents } from "@/lib/calc";

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: { transcript: string }[][] }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export default function VoiceRecorder({
  categoryLabels,
  labels,
}: {
  categoryLabels: Record<ExpenseCategoryCode, string>;
  labels: { holdToTalk: string; listening: string; notSupported: string; typeItInstead: string; confirm: string; saved: string; transcriptLabel: string };
}) {
  const router = useRouter();
  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const [result, setResult] = useState<VoiceExpenseResult | { error: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const SpeechRecognitionCtor = getSpeechRecognition();

  function startListening() {
    if (!SpeechRecognitionCtor) return;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const text = event.results.map((r) => r[0]?.transcript ?? "").join(" ");
      setTranscript(text);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setListening(true);
    setResult(null);
    recognition.start();
  }

  function stopListening() {
    recognitionRef.current?.stop();
  }

  function handleParse(text: string) {
    startTransition(async () => {
      const res = await reviewVoiceExpense(text);
      setResult(res.ok ? res.expense : { error: res.error });
    });
  }

  function handleConfirm() {
    if (!result || "error" in result) return;
    setSaveStatus("saving");
    startTransition(async () => {
      const saved = await addManualExpense({
        amountCents: result.amount_cents,
        category: result.category,
        vendor: result.vendor ?? undefined,
        spentOn: result.date,
      });
      if (saved.ok) {
        setSaveStatus("saved");
        setTimeout(() => router.push("/money"), 900);
      }
    });
  }

  if (!SpeechRecognitionCtor) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card-lg bg-card p-8 text-center">
        <p className="text-base text-ink-muted">{labels.notSupported}</p>
        <Link href="/add-cost/type" className="rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-paper">
          {labels.typeItInstead}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <button
        type="button"
        onMouseDown={startListening}
        onMouseUp={stopListening}
        onTouchStart={startListening}
        onTouchEnd={stopListening}
        className={`flex h-28 w-28 items-center justify-center rounded-full text-white ${listening ? "bg-warn" : "bg-good"}`}
        aria-label={labels.holdToTalk}
      >
        <Mic aria-hidden="true" size={40} />
      </button>
      <span className="text-base font-semibold text-ink-muted">{listening ? labels.listening : labels.holdToTalk}</span>

      {transcript && !listening && (
        <div className="w-full rounded-card-lg bg-card p-4">
          <span className="text-xs font-semibold text-ink-muted">{labels.transcriptLabel}</span>
          <p className="text-base text-ink">{transcript}</p>
          {!result && !isPending && (
            <button type="button" onClick={() => handleParse(transcript)} className="mt-3 h-11 w-full rounded-full bg-ink text-sm font-bold text-paper">
              {labels.confirm}
            </button>
          )}
        </div>
      )}

      {result && "error" in result && <p className="rounded-card-lg bg-warn-tint p-4 text-warn">{result.error}</p>}

      {result && "amount_cents" in result && (
        <div className="w-full flex-col gap-3 rounded-card-lg bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="font-headline text-2xl font-bold">{formatCents(result.amount_cents)}</span>
            <span className="text-base font-semibold">{categoryLabels[result.category]}</span>
          </div>
          {result.vendor && <span className="text-sm text-ink-muted">{result.vendor}</span>}
          <button
            type="button"
            onClick={handleConfirm}
            disabled={saveStatus === "saving"}
            className="mt-3 h-14 w-full rounded-full bg-ink text-lg font-bold text-paper disabled:opacity-40"
          >
            {saveStatus === "saved" ? labels.saved : labels.confirm}
          </button>
        </div>
      )}
    </div>
  );
}

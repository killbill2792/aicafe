"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { reviewReceiptPhoto, saveReceiptExpense } from "@/lib/actions/receiptReview";
import type { ReceiptReadingResult } from "@/lib/ai/prompts/receiptReading";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import { formatCents } from "@/lib/calc";

const MAX_DIMENSION = 1600;

async function compressToJpegDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export default function ReceiptUploader({
  categoryLabels,
  labels,
}: {
  categoryLabels: Record<ExpenseCategoryCode, string>;
  labels: { prompt: string; takePhoto: string; reading: string; looksRight: string; saved: string };
}) {
  const router = useRouter();
  const [photo, setPhoto] = useState<string | null>(null);
  const [result, setResult] = useState<{ receipt: ReceiptReadingResult; category: ExpenseCategoryCode } | { error: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  async function handleFile(file: File) {
    const dataUrl = await compressToJpegDataUrl(file);
    setPhoto(dataUrl);
    startTransition(async () => {
      const res = await reviewReceiptPhoto(dataUrl);
      setResult(res.ok ? { receipt: res.receipt, category: res.suggestedCategory } : { error: res.error });
    });
  }

  function handleSave() {
    if (!result || "error" in result) return;
    setSaveStatus("saving");
    startTransition(async () => {
      const saved = await saveReceiptExpense({ receipt: result.receipt, category: result.category, ingredientMappings: {} });
      if (saved.ok) {
        setSaveStatus("saved");
        setTimeout(() => router.push("/money"), 900);
      }
    });
  }

  if (!photo) {
    return (
      <label className="flex flex-col items-center gap-3 rounded-card-lg border-2 border-dashed border-line bg-card p-8 text-center">
        <span className="text-base font-semibold text-ink">{labels.prompt}</span>
        <span className="rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-paper">{labels.takePhoto}</span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo} alt="" className="max-h-64 w-full rounded-card-lg object-cover" />
      {isPending && !result && <p className="text-center text-base font-semibold text-ink-muted">{labels.reading}</p>}
      {result && "error" in result && <p className="rounded-card-lg bg-warn-tint p-4 text-warn">{result.error}</p>}
      {result && "receipt" in result && (
        <div className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-lg font-bold">{result.receipt.vendor}</span>
            <span className="text-lg font-bold">{formatCents(result.receipt.total_cents)}</span>
          </div>
          <span className="text-sm text-ink-muted">{result.receipt.date ?? "—"}</span>
          <div className="flex flex-col gap-1.5 border-t border-[#EFE7DB] pt-2">
            {result.receipt.lines.map((line, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="flex-1 text-ink-muted">{line.description}</span>
                <span className="font-semibold">{formatCents(line.amount_cents)}</span>
              </div>
            ))}
          </div>
          <select
            value={result.category}
            onChange={(e) => setResult({ ...result, category: e.target.value as ExpenseCategoryCode })}
            className="h-11 rounded-xl border border-line px-3 text-base font-semibold"
          >
            {EXPENSE_CATEGORY_CODES.map((c) => (
              <option key={c} value={c}>
                {categoryLabels[c]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleSave}
            disabled={saveStatus === "saving"}
            className="h-14 rounded-full bg-ink text-lg font-bold text-paper disabled:opacity-40"
          >
            {saveStatus === "saved" ? labels.saved : labels.looksRight}
          </button>
        </div>
      )}
    </div>
  );
}

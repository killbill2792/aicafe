"use client";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
export type BadgeTone = "neutral" | "accent" | "pos" | "neg" | "warn" | "estimate" | "unverified";
const tones: Record<BadgeTone,string> = {neutral:"bg-surface2 text-fg",accent:"bg-accent-soft text-accent-text",pos:"bg-pos-soft text-pos",neg:"bg-neg-soft text-neg",warn:"bg-warn-soft text-warn-text",estimate:"bg-warn-soft text-warn-text",unverified:"border border-dashed border-warn-text bg-warn-soft text-warn-text"};
export function Badge({children, tone = "neutral", unverifiedLabel}: {children?: ReactNode; tone?: BadgeTone; unverifiedLabel?: string}) { const t = useTranslations("Ui"); return <span className={`inline-flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-sm font-semibold ${tones[tone]}`}>{tone === "unverified" && <AlertTriangle size={15} aria-hidden="true"/>}{tone === "unverified" ? <>{unverifiedLabel ?? t("unverified")}{children && <>: {children}</>}</> : children}</span>; }

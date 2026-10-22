"use client";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
export function EmptyState({title, description, action}: {title?: string; description?: string; action?: ReactNode}) { const t = useTranslations("Ui"); return <div className="rounded-card-lg border border-dashed border-line bg-surface p-6 text-center"><h3 className="font-headline text-xl font-bold text-fg">{title ?? t("emptyTitle")}</h3><p className="mt-2 text-[17px] leading-[1.4] text-muted">{description ?? t("emptyDescription")}</p>{action && <div className="mt-4">{action}</div>}</div>; }

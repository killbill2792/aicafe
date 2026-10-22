import type { ReactNode } from "react";
export function SectionHeader({title, action}: {title: ReactNode; action?: ReactNode}) { return <div className="flex min-h-12 items-center justify-between gap-3"><h2 className="font-headline text-xl font-bold text-fg">{title}</h2>{action}</div>; }

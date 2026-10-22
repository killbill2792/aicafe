import type { HTMLAttributes } from "react";
export function Card({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={`rounded-card-lg border border-line bg-surface p-4 shadow-card ${className}`} />;
}

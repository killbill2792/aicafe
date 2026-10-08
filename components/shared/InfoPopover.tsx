"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";

export default function InfoPopover({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex h-12 w-12 items-center justify-center rounded-full text-ink-muted hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Info aria-hidden="true" size={18} />
      </button>
      {open && (
        <span
          id={panelId}
          role="note"
          className="absolute end-0 top-full z-30 mt-1 w-64 rounded-2xl border border-line bg-card p-3 text-xs font-normal leading-relaxed text-ink shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { themes, type ThemeId, type ThemeMode } from "@/app/themes";

function persist(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}
export function ThemePicker({initialTheme, initialMode}: {initialTheme: ThemeId; initialMode: ThemeMode}) {
  const t = useTranslations("Ui");
  const [theme,setTheme] = useState(initialTheme);
  const [mode,setMode] = useState<ThemeMode>(initialMode);
  const pickTheme = (id: ThemeId) => { document.documentElement.setAttribute('data-theme', id); setTheme(id); persist("cp_theme",id); };
  const pickMode = (id: ThemeMode) => { document.documentElement.setAttribute('data-mode', id); setMode(id); persist("cp_mode",id); };
  return <section aria-labelledby="theme-heading" className="rounded-card-lg border border-line bg-surface p-4">
    <h2 id="theme-heading" className="font-headline text-xl font-bold text-fg">{t("theme")}</h2>
    <p className="mt-1 text-sm text-muted">{t("themeDescription")}</p>
    <div role="radiogroup" aria-label={t("chooseTheme")} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {themes.map((item) => {
        const selected=theme===item.id;
        return <button key={item.id} type="button" role="radio" aria-checked={selected} tabIndex={selected?0:-1}
          onKeyDown={(event) => {if (!["ArrowDown","ArrowUp","ArrowRight","ArrowLeft"].includes(event.key)) return;
            event.preventDefault(); const delta=event.key==="ArrowRight"||event.key==="ArrowDown"?1:-1;
            const next=themes[(themes.findIndex(t=>t.id===theme)+delta+themes.length)%themes.length];pickTheme(next.id);(event.currentTarget.parentElement?.querySelectorAll('[role="radio"]')[themes.findIndex(t=>t.id===next.id)] as HTMLButtonElement)?.focus();}}
          onClick={() => pickTheme(item.id)} className={`relative min-h-24 rounded-card border p-3 text-start focus-visible:outline-focus ${selected?"border-accent-text ring-2 ring-accent-text ring-offset-2 ring-offset-surface":"border-line"}`}>
          <span className="mb-2 flex gap-1.5" aria-hidden="true">{(["bg","surface","accent","accentSoft"] as const).map(key => <span key={key} className="h-5 w-5 rounded-full border border-line" style={{backgroundColor:item[mode==="dark"?"dark":"light"][key]}} />)}</span>
          <span className="block pe-5 text-sm font-semibold text-fg">{t(`themes.${item.nameKey}`)}</span>
          {selected && <Check aria-hidden="true" size={18} className="absolute end-2 top-2 text-accent-text"/>}
        </button>;
      })}
    </div>
    <div className="mt-5" role="group" aria-label={t("appearance")}><span className="mb-2 block text-sm font-semibold text-fg">{t("appearance")}</span><div className="grid grid-cols-3 gap-1 rounded-chip bg-surface2 p-1">
      {(["light","dark","system"] as const).map(item => <button type="button" key={item} aria-pressed={mode===item} onClick={() => pickMode(item)} className={`min-h-12 rounded-chip px-3 text-sm font-semibold focus-visible:outline-focus ${mode===item?"bg-accent text-on-accent":"text-fg"}`}>{t(item)}</button>)}
    </div></div>
  </section>;
}

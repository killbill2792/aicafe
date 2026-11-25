"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import { themeArrowDelta } from "./themePickerKeyboard";
import { useTranslations } from "next-intl";
import en from "@/messages/en.json";
import { themes, type ThemeId, type ThemeMode } from "@/app/themes";
import { TEXT_SIZES, DEFAULT_TEXT_SIZE, type TextSize } from "@/app/textSize";

function persist(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}
export function ThemePicker({initialTheme, initialMode, initialTextSize = DEFAULT_TEXT_SIZE}: {initialTheme: ThemeId; initialMode: ThemeMode; initialTextSize?: TextSize}) {
  const t = useTranslations("Ui");
  const [theme,setTheme] = useState(initialTheme);
  const [mode,setMode] = useState<ThemeMode>(initialMode);
  const [textSize,setTextSize] = useState<TextSize>(initialTextSize);
  const pickTheme = (id: ThemeId) => { document.documentElement.setAttribute('data-theme', id); setTheme(id); persist("cp_theme",id); };
  const pickMode = (id: ThemeMode) => { document.documentElement.setAttribute('data-mode', id); setMode(id); persist("cp_mode",id); };
  const pickTextSize = (id: TextSize) => { document.documentElement.setAttribute("data-text-size", id); setTextSize(id); persist("cp_text",id); };
  return <section aria-labelledby="theme-heading" className="rounded-card-lg border border-line bg-surface p-4">
    <h2 id="theme-heading" className="font-headline text-xl font-bold text-fg">{t("theme")}</h2>
    <p className="mt-1 text-[1.0625rem] leading-[1.4] text-muted">{t("themeDescription")}</p>
    <div role="radiogroup" aria-label={t("chooseTheme")} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {themes.map((item) => {
        const selected=theme===item.id;
        return <button key={item.id} type="button" role="radio" aria-checked={selected} tabIndex={selected?0:-1}
          onKeyDown={(event) => {if (!["ArrowDown","ArrowUp","ArrowRight","ArrowLeft"].includes(event.key)) return;
            const delta=themeArrowDelta(event.key, document.documentElement.dir === "rtl" ? "rtl" : "ltr");
            if (delta === null) return;
            event.preventDefault();
            const next=themes[(themes.findIndex(t=>t.id===theme)+delta+themes.length)%themes.length];pickTheme(next.id);(event.currentTarget.parentElement?.querySelectorAll('[role="radio"]')[themes.findIndex(t=>t.id===next.id)] as HTMLButtonElement)?.focus();}}
          onClick={() => pickTheme(item.id)} className={`relative min-h-24 rounded-card border p-3 text-start focus-visible:outline-focus ${selected?"border-accent-text ring-2 ring-accent-text ring-offset-2 ring-offset-surface":"border-line"}`}>
          <span className="mb-2 flex gap-1.5" aria-hidden="true">{(["bg","surface","accent","accentSoft"] as const).map(key => <span key={key} className="relative h-5 w-5 overflow-hidden rounded-full border border-line"><span className="theme-preview-light absolute inset-0" style={{backgroundColor:item.light[key]}} /><span className="theme-preview-dark absolute inset-0" style={{backgroundColor:item.dark[key]}} /></span>)}</span>
          <span className="block pe-5 text-sm font-semibold text-fg">{item.nameKey==="glass"?en.Ui.themes.glass:t(`themes.${item.nameKey}`)}</span>
          {selected && <Check aria-hidden="true" size={18} className="absolute end-2 top-2 text-accent-text"/>}
        </button>;
      })}
    </div>
    <div className="mt-5" role="group" aria-label={t("appearance")}><span className="mb-2 block text-sm font-semibold text-fg">{t("appearance")}</span><div className="grid grid-cols-3 gap-1 rounded-chip bg-surface2 p-1">
      {(["light","dark","system"] as const).map(item => <button type="button" key={item} aria-pressed={mode===item} onClick={() => pickMode(item)} className={`min-h-12 rounded-chip px-3 text-sm font-semibold focus-visible:outline-focus ${mode===item?"bg-accent text-on-accent":"text-fg"}`}>{t(item)}</button>)}
    </div></div>
    <div className="mt-5" role="radiogroup" aria-label={en.Ui.textSize}><span className="mb-2 block text-sm font-semibold text-fg">{en.Ui.textSize}</span><div className="grid grid-cols-4 gap-1 rounded-chip border border-line bg-surface2 p-1">
      {TEXT_SIZES.map(item => <button type="button" key={item} role="radio" aria-checked={textSize===item} onClick={() => pickTextSize(item)} className={`min-h-12 rounded-chip px-2 text-sm font-semibold focus-visible:outline-focus ${textSize===item?"bg-accent text-on-accent":"text-fg"}`}>{en.Ui.textSizes[item]}</button>)}
    </div></div>
  </section>;
}

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { themes, parseModeCookie, parseThemeCookie } from "./themes";
const luminance = (hex: string) => { const [r,g,b] = hex.slice(1).match(/../g)!.map(x=>parseInt(x,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b; };
const contrast = (a: string,b: string) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
const tokenNames=Object.keys(themes[0].light);
describe("theme foundation",()=>{
  it("defines every semantic token for all eight light/dark themes",()=>{
    expect(themes).toHaveLength(8);
    expect(new Set(themes.map(t=>t.id)).size).toBe(8);
    for(const theme of themes)for(const mode of ["light","dark"] as const){
      const t=theme[mode];expect(Object.keys(t).sort()).toEqual([...tokenNames].sort());
      for(const value of Object.values(t))expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
  it("meets WCAG AA text and focus requirements",()=>{
    for(const theme of themes)for(const mode of ["light","dark"] as const){
      const t:Record<string,string>=theme[mode];
      for(const [a,b,min] of [
        ["text","bg",4.5],["text","surface",4.5],["muted","bg",4.5],["muted","surface",4.5],
        ["onAccent","accent",4.5],["accentText","surface",4.5],["accentText","accentSoft",4.5],["onPos","pos",4.5],["onWarn","warnText",4.5],["onNeg","neg",4.5],["warnText","surface",4.5],
        ["pos","surface",4.5],["neg","surface",4.5],["line","surface",1.3],["focus","surface",3],
        ["pos","posSoft",4.5],["neg","negSoft",4.5],["warnText","warnSoft",4.5],
      ] as const)expect(contrast(t[a],t[b]),`${theme.id}/${mode}/${a}-${b}`).toBeGreaterThanOrEqual(min);
    }
  });
  it("checks committed CSS against the source",()=>{expect(()=>execFileSync(process.execPath,["scripts/build-themes.mjs","--check"])).not.toThrow()});
  it("uses safe cookie defaults",()=>{
    expect(parseThemeCookie(undefined)).toBe("fresh-pour");
    expect(parseThemeCookie("invalid")).toBe("fresh-pour");
    expect(parseThemeCookie("matcha")).toBe("matcha");
    expect(parseModeCookie(undefined)).toBe("system");
    expect(parseModeCookie("invalid")).toBe("system");
    expect(parseModeCookie("dark")).toBe("dark");
  });
  it("keeps shared component spacing RTL logical",()=>{
    for(const f of readdirSync("components/ui").filter(s=>s.endsWith(".tsx"))){
      const value=readFileSync(`components/ui/${f}`,"utf8");
      expect(value).not.toMatch(/(?:^|[\s"'])(?:[\w]+:)*(?:ml|mr|pl|pr|left|right|text-left|text-right)-/);
    }
  });
});

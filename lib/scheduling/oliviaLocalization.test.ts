import {describe,expect,it} from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import ar from "../../messages/ar.json";

describe("Olivia scheduling owner interface localization contract",()=>{
  const locales={en:en.OliviaPlanning,es:es.OliviaPlanning,ar:ar.OliviaPlanning};
  const placeholders=(value:string)=>[...value.matchAll(/\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:[,}]?)/g)]
    .map(match=>match[1]).sort();
  it("has a complete nonempty localized key set in English, Spanish, and Arabic",()=>{
    const englishKeys=Object.keys(locales.en).sort();
    expect(englishKeys.length).toBeGreaterThan(100);
    for(const [locale,messages] of Object.entries(locales)){
      expect(Object.keys(messages).sort(),locale).toEqual(englishKeys);
      for(const [key,value] of Object.entries(messages)){
        expect(typeof value,locale+":"+key).toBe("string");
        expect(value.trim().length,locale+":"+key).toBeGreaterThan(0);
      }
    }
  });
  it("preserves all named ICU replacements in translated owner warnings",()=>{
    for(const key of Object.keys(locales.en) as Array<keyof typeof locales.en>){
      const original=placeholders(locales.en[key]);
      expect(placeholders(locales.es[key]),"es:"+key).toEqual(original);
      expect(placeholders(locales.ar[key]),"ar:"+key).toEqual(original);
    }
  });
});

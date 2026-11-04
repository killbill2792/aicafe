import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type {AgentLocale} from "./index";

/** Present the shared Toast trust keys as ONE localized note per issue, while
 * retaining machine-readable missingInputs for existing quality consumers. */
export function localizeQualityNotes(keys:readonly string[],locale:AgentLocale):string[]{
 const copy={en,es,ar}[locale].DataNotes;
 const notes:string[]=[];
 for(const key of keys){
  const match=/^toastDaysNeedLook:(\d+):([^:]+):(\d+)$/.exec(key);
  if(match){
   const extra=Number(match[3]);
   notes.push(copy.toastDaysNeedLook.replace("{count}",match[1])
    .replace("{dates}",match[2].replaceAll(", ",", ").replaceAll(",",", "))
    .replace("{more}",extra?copy.toastMoreDays.replace("{count}",String(extra)):""));
  }else if(key.startsWith("toastImportIncompleteDays:")){
   const match=/^toastImportIncompleteDays:(\d+):([^:]+):(\d+)$/.exec(key);
   if(match)notes.push(copy.toastImportIncompleteDays.replace("{count}",match[1])
    .replace("{dates}",match[2].replaceAll(",",", "))
    .replace("{more}",Number(match[3])?copy.toastMoreDays.replace("{count}",match[3]):""));
  }else if(key==="toastDayStatusUnavailable")notes.push(copy.toastDayStatusUnavailable);
  else if(key.startsWith("toastFailedNoCanonicalSales:"))
   notes.push(copy.toastFailedNoCanonicalSales.replace("{dates}",key.slice("toastFailedNoCanonicalSales:".length).replaceAll(",",", ")));
  else if(key.startsWith("toastDayStatusMissing:"))
   notes.push(copy.toastDayStatusMissing.replace("{dates}",key.slice("toastDayStatusMissing:".length).replaceAll(",",", ")));
 }
 return [...new Set(notes)];
}

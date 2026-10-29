import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

/** Render structured finance reason keys at the chat boundary, never in arithmetic. */
export function localizedMetricReason(key:string,locale:"en"|"es"|"ar",
 params:Readonly<Record<string,string|number>>={}):string{
 const messages=({en,es,ar}[locale].MetricsNotes) as Record<string,string>;
 const template=messages[key];
 // Legacy reasons should never leak into a different-language answer.
 if(!template)return messages.metricReasonUnknown;
 return template.replace(/\{([a-zA-Z]+)\}/g,(_,name:string)=>
  String(params[name]??""));
}

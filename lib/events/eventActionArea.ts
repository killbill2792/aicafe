import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

type Locale="en"|"es"|"ar";

/** One owner-language label for an event-readiness action, shared by the
 * saved day checklist and the existing Supervisor approval-card preview. */
const areaKeys={
  staff:"areaStaff",
  prep:"areaPrep",
  ordering:"areaOrdering",
  promo:"areaPromo",
  hours:"areaHours",
  operations:"areaOperations",
} as const;
export const eventActionAreas=Object.keys(areaKeys) as Array<keyof typeof areaKeys>;
const catalogs={en,es,ar} as const;

export function eventActionAreaLabel(area:string,locale:Locale):string{
  const key=Object.hasOwn(areaKeys,area)
    ?areaKeys[area as keyof typeof areaKeys]:"areaOther";
  return catalogs[locale].EventsPanel[key];
}

import {MapPin} from "lucide-react";

/** Saved, sourced venue address only. A Maps link is not a measured distance. */
export function eventMapSearchUrl(address:string|null|undefined):string|null{
  if(typeof address!=="string")return null;
  const value=address.trim();
  if(!value||value.length>500||/[\u0000-\u001f\u007f]/u.test(value))return null;
  return "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(value);
}

/** No geocoding, browser location, network request, or search on render. */
export default function EventMapLink({address,label}:{address:string|null;label:string}){
  const href=eventMapSearchUrl(address);
  if(!href)return null;
  return <a href={href} target="_blank" rel="noopener noreferrer"
    className="inline-flex min-h-12 max-w-full items-center gap-2 break-words text-[17px] text-accent-text underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
    <MapPin size={18} aria-hidden="true"/>
    <span>{label}: <bdi>{address!.trim()}</bdi></span>
  </a>;
}

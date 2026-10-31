export type EventChatContext={date:string;title:string;threadId:string;eventId?:string};

/** Individual saved events never share a thread solely because they share a date. */
export function eventThreadKey(date:string,eventId?:string):string{
  return eventId?"event:"+eventId:"day:"+date;
}

/** Persist the saved event ID in the thread title to restore identity on reload. */
export function eventThreadTitle(date:string,title:string,eventId?:string):string {
  const suffix=eventId?" · event:"+eventId:"";
  const prefix="Events · "+date+" · ";
  const safe=title.replace(/[\r\n<>]/g," ").trim().slice(0,Math.max(0,120-prefix.length-suffix.length));
  return prefix+safe+suffix;
}
export function eventContextFromTitle(title:string,threadId:string):EventChatContext|null {
  const exact=/^Events · (\d{4}-\d{2}-\d{2}) · (.+) · event:([\da-f-]{36})$/i.exec(title);
  if(exact&&Number.isFinite(Date.parse(exact[1]+"T12:00:00Z")))
    return {date:exact[1],title:exact[2],eventId:exact[3],threadId};
  const old=/^Events · (\d{4}-\d{2}-\d{2}) · (.{1,100})$/.exec(title);
  if(old&&Number.isFinite(Date.parse(old[1]+"T12:00:00Z")))
    return {date:old[1],title:old[2],threadId};
  // Historical day-only threads remain day-scoped; never infer an event ID.
  const legacy=/^Events · (\d{4}-\d{2}-\d{2})$/.exec(title);
  return legacy&&Number.isFinite(Date.parse(legacy[1]+"T12:00:00Z"))?
    {date:legacy[1],title:"Event",threadId}:null;
}

/** Reuse the exact existing event conversation after page reload; don't match only by day. */
export function eventThreadFromHistory(
  threads:readonly {id:string;title:string|null}[],date:string,eventId?:string,
):string|null{
  const key=eventThreadKey(date,eventId);
  for(const thread of threads){
    const context=thread.title?eventContextFromTitle(thread.title,thread.id):null;
    if(context&&eventThreadKey(context.date,context.eventId)===key)return thread.id;
  }
  return null;
}

/** Persist a compact, explicit anchor with each owner message, without plan JSON. */
export function eventOwnerMessage(text:string,context:EventChatContext|null):string {
  const trimmed=text.trim();
  if(!context||!trimmed||/^@event\s/i.test(trimmed))return trimmed;
  const safeTitle=context.title.replace(/[\r\n<>]/g," ").trim().slice(0,100);
  const id=context.eventId?" [id:"+context.eventId+"]":"";
  return "@event "+safeTitle+" ("+context.date+")"+id+"\n"+trimmed;
}

/** Explicit tap only; the event ID is used for the cache, never date alone. */
export async function openEventDayThread(args:{
  date:string;title:string;eventId?:string;known:Map<string,string>;
  create:(title:string)=>Promise<{id:string}>;
  select:(id:string)=>void;
}):Promise<string>{
  const key=eventThreadKey(args.date,args.eventId);
  const existing=args.known.get(key);
  if(existing){args.select(existing);return existing;}
  const created=await args.create(eventThreadTitle(args.date,args.title,args.eventId));
  args.known.set(key,created.id);
  args.select(created.id);
  return created.id;
}

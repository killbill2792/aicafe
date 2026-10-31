export type EventChatContext={date:string;title:string;threadId:string};

/** Encode a specific day in a human-readable thread title, not an event JSON blob. */
export function eventThreadTitle(date:string,title:string):string {
  return "Events · "+date+" · "+title.replace(/[\r\n<>]/g," ").trim().slice(0,96);
}
export function eventContextFromTitle(title:string,threadId:string):EventChatContext|null {
  const match=/^Events · (\d{4}-\d{2}-\d{2}) · (.{1,100})$/.exec(title);
  if(match&&Number.isFinite(Date.parse(match[1]+"T12:00:00Z")))
    return {date:match[1],title:match[2],threadId};
  // Older saved day threads were titled just "Events · YYYY-MM-DD".
  // Recover their date without inventing an event name or erasing chat history.
  const legacy=/^Events · (\d{4}-\d{2}-\d{2})$/.exec(title);
  return legacy&&Number.isFinite(Date.parse(legacy[1]+"T12:00:00Z"))?
    {date:legacy[1],title:"Event",threadId}:null;
}
/** The saved owner's message carries its event anchor across thread reloads. */
export function eventOwnerMessage(text:string,context:EventChatContext|null):string {
  const trimmed=text.trim();
  if(!context||!trimmed||/^@event\s/i.test(trimmed))return trimmed;
  const safeTitle=context.title.replace(/[\r\n<>]/g," ").trim().slice(0,100);
  return "@event "+safeTitle+" ("+context.date+")\n"+trimmed;
}

/** Only an explicit Chat about this tap selects/creates the ordinary chat thread.
 * Never send saved JSON, plan text, or an unsolicited approval prompt. */
export async function openEventDayThread(args:{
  date:string;title:string;known:Map<string,string>;
  create:(title:string)=>Promise<{id:string}>;
  select:(id:string)=>void;
}):Promise<string>{
  const existing=args.known.get(args.date);
  if(existing){args.select(existing);return existing;}
  const created=await args.create(eventThreadTitle(args.date,args.title));
  args.known.set(args.date,created.id);
  args.select(created.id);
  return created.id;
}

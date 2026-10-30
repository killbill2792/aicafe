/** Only an explicit Chat about this tap selects/creates the ordinary chat thread.
 * Never send saved JSON, plan text, or an unsolicited approval prompt. */
export async function openEventDayThread(args:{
  date:string;title:string;known:Map<string,string>;
  create:(title:string)=>Promise<{id:string}>;
  select:(id:string)=>void;
}):Promise<string>{
  const existing=args.known.get(args.date);
  if(existing){args.select(existing);return existing;}
  const created=await args.create(args.title);
  args.known.set(args.date,created.id);
  args.select(created.id);
  return created.id;
}

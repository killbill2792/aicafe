/** Open the selected event day in its own ordinary chat thread. The same
 * day reuses its thread within this session; no second conversation store. */
export async function openEventDayThread(args:{
  date:string;title:string;prompt:string;known:Map<string,string>;
  create:(title:string)=>Promise<{id:string}>;
  select:(id:string)=>void;
  send:(prompt:string,id:string)=>Promise<void>;
}):Promise<string>{
  const existing=args.known.get(args.date);
  if(existing){args.select(existing);return existing;}
  const created=await args.create(args.title);
  args.known.set(args.date,created.id);
  args.select(created.id);
  await args.send(args.prompt,created.id);
  return created.id;
}

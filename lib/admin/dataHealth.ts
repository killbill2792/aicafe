/** Plain-words lines for the admin Data health page. Pure, so it is unit tested. */
export type HealthFinding =
  | {kind:"database_near_limit";database_bytes:number;plan_bytes:number}
  | {kind:"sudden_growth";database_bytes:number;previous_bytes:number}
  | {kind:"repeated_pos_records";business_id:string;entity:string;objects:number;extra_rows:number}
  | {kind:"total_mismatch";business_id:string;business_date:string;import_net_cents:number;
      stored_net_cents:number;toast_net_cents:number|null};

/** Supabase plan database size; override with DATABASE_PLAN_BYTES. Default 8 GB (Pro plan). */
export function planBytes(env:string|undefined):number{
  const n=Number(env);
  return Number.isSafeInteger(n)&&n>0?n:8*1024**3;
}
export const megabytes=(bytes:number)=>Math.round(bytes/1024/1024).toLocaleString("en-US")+" MB";
const money=(cents:number|null)=>cents===null?"none":(cents/100).toFixed(2);

export function describeFinding(f:HealthFinding,cafeName:(id:string)=>string):string{
  switch(f.kind){
    case "database_near_limit":
      return `Database is ${megabytes(f.database_bytes)}, over 70% of the ${megabytes(f.plan_bytes)} plan.`;
    case "sudden_growth":
      return `Database grew from ${megabytes(f.previous_bytes)} to ${megabytes(f.database_bytes)} since the last check.`;
    case "repeated_pos_records":
      return `${cafeName(f.business_id)}: ${f.objects} Toast ${f.entity} records stored more than once on the same day (${f.extra_rows} extra rows).`;
    case "total_mismatch":
      return `${cafeName(f.business_id)} ${f.business_date}: stored orders ${money(f.stored_net_cents)}, import total ${money(f.import_net_cents)}, Toast total ${money(f.toast_net_cents)}.`;
  }
}

/** Only known shapes are shown; anything else is counted, never guessed. */
export function parseFindings(value:unknown):{known:HealthFinding[];unknown:number}{
  const list=Array.isArray(value)?value:[];
  const known:HealthFinding[]=[];let unknown=0;
  for(const item of list){
    const kind=(item as {kind?:unknown})?.kind;
    if(kind==="database_near_limit"||kind==="sudden_growth"||kind==="repeated_pos_records"||kind==="total_mismatch")
      known.push(item as HealthFinding);
    else unknown++;
  }
  return {known,unknown};
}

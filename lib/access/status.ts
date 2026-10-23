export type CafeAccess={mode:"grandfathered"|"code"|"paused";accessEnd:string|null;active:boolean;daysLeft:number|null;remind:boolean};
export function accessStatus(row:{mode?:string|null;access_end?:string|null}|null,now=new Date()):CafeAccess{
  if(!row||row.mode==="grandfathered")return{mode:"grandfathered",accessEnd:null,active:true,daysLeft:null,remind:false};
  if(row.mode==="paused")return{mode:"paused",accessEnd:row.access_end??null,active:false,daysLeft:null,remind:false};
  const end=row.access_end??null;
  if(!end)return{mode:"paused",accessEnd:null,active:false,daysLeft:null,remind:false};
  const today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  const days=Math.round((Date.parse(end+"T00:00:00Z")-today)/86400000);
  return {mode:"code",accessEnd:end,active:days>=0,daysLeft:days,remind:days>=0&&days<=7};
}
export function normalizeCode(code:string):string{return code.trim().replace(/\s+/g,"").toUpperCase();}
export function validCode(code:string):boolean{return /^[A-Z0-9-]{6,32}$/.test(normalizeCode(code));}

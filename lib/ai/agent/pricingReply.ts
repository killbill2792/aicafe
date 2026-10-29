/** Match a tool-verified price in the reply, never a numeric substring. */
export function verifiedRecommendedPriceInReply(reply:string,cents:number,
 locale:"en"|"es"|"ar",unverified:readonly {start:number;end:number}[],currency?:string|null):boolean{
 if(!Number.isSafeInteger(cents)||cents<0)return false;
 const amount=cents/100;
 const tokens=[new Intl.NumberFormat(locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(amount),
  ...(currency?[new Intl.NumberFormat(locale,{style:"currency",currency}).format(amount)]:[])];
 const isDigit=(char:string)=>/[\p{N}]/u.test(char);
 for(const token of tokens){
  // Strip only bidi controls; retain locale's decimal and grouping characters.
  const numeric=token.replace(/[\u200e\u200f\u061c]/gu,"")
    .match(/[\p{N}][\p{N}.,٫٬\s\u00a0]*[\p{N}]/u)?.[0]?.trim();
  if(!numeric)continue;
  let from=0;
  while(from<reply.length){
   const start=reply.indexOf(numeric,from);
   if(start<0)break;
   const end=start+numeric.length,prev=reply[start-1]??"",next=reply[end]??"";
   const previousGrouped=/[.,٫٬]/u.test(prev)&&isDigit(reply[start-2]??"");
   const nextGrouped=/[.,٫٬]/u.test(next)&&isDigit(reply[end+1]??"");
   if(!isDigit(prev)&&!isDigit(next)&&!previousGrouped&&!nextGrouped&&
    !unverified.some(span=>span.start<end&&span.end>start))return true;
   from=end;
  }
 }
 return false;
}

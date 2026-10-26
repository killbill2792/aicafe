/** Normalize employee contact numbers against the café's country dialing plan.
 * E.164's regex only checks syntax: a national trunk 0 after +44/+33/+971
 * is still syntactically valid but points at the wrong recipient.
 * Countries with unsupported domestic prefixes are rejected, never guessed.
 */
type DialPlan={code:string;min:number;max:number;trunkZero?:"strip"|"retain"};
const plans:Record<string,DialPlan>={
 US:{code:"1",min:10,max:10},CA:{code:"1",min:10,max:10},
 MX:{code:"52",min:10,max:10},ES:{code:"34",min:9,max:9},
 GB:{code:"44",min:10,max:10,trunkZero:"strip"},
 UK:{code:"44",min:10,max:10,trunkZero:"strip"},
 FR:{code:"33",min:9,max:9,trunkZero:"strip"},
 DE:{code:"49",min:5,max:13,trunkZero:"strip"},
 IT:{code:"39",min:6,max:11,trunkZero:"retain"},
 PT:{code:"351",min:9,max:9},
 AE:{code:"971",min:8,max:9,trunkZero:"strip"},
 SA:{code:"966",min:9,max:9,trunkZero:"strip"},
 EG:{code:"20",min:9,max:10,trunkZero:"strip"},
 MA:{code:"212",min:9,max:9,trunkZero:"strip"},
 JO:{code:"962",min:8,max:9,trunkZero:"strip"},
 IN:{code:"91",min:10,max:10,trunkZero:"strip"},
 PK:{code:"92",min:9,max:11,trunkZero:"strip"},
 AU:{code:"61",min:9,max:9,trunkZero:"strip"},
 NZ:{code:"64",min:8,max:10,trunkZero:"strip"},
 BR:{code:"55",min:10,max:11},
 AR:{code:"54",min:10,max:11},
 CO:{code:"57",min:10,max:10}
};
const byCallingCode=new Map<string,DialPlan>(Object.values(plans).map(plan=>[plan.code,plan]));
const knownCodes=[...byCallingCode.keys()].sort((a,b)=>b.length-a.length);

/** Return E.164, null for empty input, or undefined when conversion is unsafe. */
export function normalizeStaffPhone(value:string|null|undefined,country:string|null|undefined):string|null|undefined {
 if(value==null||!value.trim())return null;
 const latin=value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>{
  const n=c.charCodeAt(0);return String(n>=0x6f0?n-0x6f0:n-0x660);
 });
 if(!/^[+0-9\s().-]+$/.test(latin))return undefined;
 const stripped=latin.replace(/[\s().-]/g,"");
 let result:string;
 if(stripped.startsWith("00"))result="+"+stripped.slice(2);
 else if(stripped.startsWith("+"))result=stripped;
 else {
  const plan=plans[country?.toUpperCase()??""];
  if(!plan)return undefined;
  let national=stripped;
  if(plan.trunkZero==="strip"&&national.startsWith("0"))national=national.slice(1);
  else if(plan.trunkZero!=="retain"&&national.startsWith("0"))return undefined;
  if(plan.code==="1"&&national.length===11&&national.startsWith("1"))national=national.slice(1);
  result="+"+plan.code+national;
 }
 if(!/^\+[1-9][0-9]{1,14}$/.test(result))return undefined;
 // Validate recognized country plans regardless of whether the owner typed
 // a local number, +international number, or 00international number. Explicit
 // +44 0..., +33 0..., and +971 0... must not bypass trunk validation.
 const code=knownCodes.find(key=>result.startsWith("+"+key));
 if(code){
  const plan=byCallingCode.get(code)!;
  const national=result.slice(code.length+1);
  if(plan.trunkZero==="strip"&&national.startsWith("0"))return undefined;
  if(national.length<plan.min||national.length>plan.max)return undefined;
 }
 return result;
}
export function formatStaffPhonePreview(number:string):string{
 if(/^\+1\d{10}$/.test(number))return `${number.slice(0,2)} ${number.slice(2,5)} ${number.slice(5,8)} ${number.slice(8)}`;
 return number;
}

/** Convert owner-entered phone numbers without guessing country from app language. */
const dial:Record<string,string>={US:"1",CA:"1",MX:"52",ES:"34",GB:"44",UK:"44",
 FR:"33",DE:"49",IT:"39",PT:"351",AE:"971",SA:"966",EG:"20",MA:"212",
 JO:"962",IN:"91",PK:"92",AU:"61",NZ:"64",BR:"55",AR:"54",CO:"57"};
export function normalizeStaffPhone(value:string|null|undefined,country:string|null|undefined):string|null|undefined {
 if(value==null||!value.trim())return null;
 const latin=value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>{
  const n=c.charCodeAt(0);return String(n>=0x6f0?n-0x6f0:n-0x660);
 });
 if(!/^[+0-9\s().-]+$/.test(latin))return undefined;
 const stripped=latin.replace(/[\s().-]/g,""),prefix=dial[country?.toUpperCase()??""];
 let result:string|undefined;
 if(stripped.startsWith("00"))result="+"+stripped.slice(2);
 else if(stripped.startsWith("+"))result=stripped;
 else if(prefix)result="+"+(prefix==="1"&&stripped.startsWith("1")&&stripped.length===11?stripped:prefix+stripped);
 return result&&/^\+[1-9][0-9]{1,14}$/.test(result)&&
  (!result.startsWith("+1")||result.length===12)&&
  (!result.startsWith("+34")||result.length===12)&&
  (!result.startsWith("+52")||result.length===13)?result:undefined;
}
export function formatStaffPhonePreview(number:string):string{
 if(/^\+1\d{10}$/.test(number))return `${number.slice(0,2)} ${number.slice(2,5)} ${number.slice(5,8)} ${number.slice(8)}`;
 return number;

}

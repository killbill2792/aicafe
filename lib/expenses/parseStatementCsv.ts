import Papa from "papaparse";

export type ParsedStatementLine = {
  i: number;
  date: string;
  description: string;
  amountCents: number; // negative = money out
  balanceCents: number | null;
};

export type ParsedStatement = {
  lines: ParsedStatementLine[];
  balanceCheck: { openingCents: number; closingCents: number; sumCents: number; ok: boolean } | null;
  unrecognizedColumns: boolean;
  invalidRows: number[];
  sourceErrors: boolean;
  /** Ordered original rows only; never reconstructed from edited expenses. */
  statementEvidence: { from: string; to: string; openingCents: number; closingCents: number;
    transactions: { i: number; date: string; amountCents: number; balanceCents: number }[] } | null;
};

function toDateStr(raw: string): string | null {
  const trimmed = raw.trim();
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const value = us ? (us[3].length === 2 ? "20"+us[3] : us[3])+"-"+us[1].padStart(2,"0")+"-"+us[2].padStart(2,"0") : trimmed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value+"T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value ? value : null;
}

function toCents(raw: string): number | null {
  let value = raw.trim();
  const accounting = /^\(.*\)$/.test(value);
  if(accounting)value=value.slice(1,-1).trim();
  const match=value.match(/^([+-]?)\$?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/);
  if(!match||(accounting&&match[1]))return null;
  const whole=Number(match[2].replace(/,/g,""));
  const cents=whole*100+Number((match[3]??"").padEnd(2,"0"));
  return Number.isSafeInteger(cents)?(accounting||match[1]==="-"?-cents:cents):null;
}

/** Reject ambiguous or malformed transaction rows instead of turning them into zeros. */
export function parseStatementCsv(csvText: string): ParsedStatement {
  const parsed=Papa.parse<Record<string,string>>(csvText,{header:true,skipEmptyLines:"greedy",transformHeader:h=>h.trim().toLowerCase()});
  const headers=parsed.meta.fields??[];
  const find=(patterns:RegExp[])=>patterns.map(p=>headers.find(h=>p.test(h))).find(Boolean);
  const dateHeader=find([/^date$/, /trans.*date/, /posted/]);
  const descHeader=find([/^description$/, /desc/, /memo/, /payee/, /^name$/, /^transaction$/]);
  const amountHeader=find([/^amount$/]);
  const debitHeader=find([/^debit$/, /withdrawal/]);
  const creditHeader=find([/^credit$/, /deposit/]);
  const balanceHeader=find([/^balance$/, /^running balance$/, /^closing balance$/]);
  const unrecognizedColumns=!dateHeader||!descHeader||(!amountHeader&&!debitHeader&&!creditHeader);
  const sourceErrors=parsed.errors.length>0||Boolean(parsed.meta.renamedHeaders&&Object.keys(parsed.meta.renamedHeaders).length);
  const invalidRows:number[]=[];
  const lines:ParsedStatementLine[]=[];
  if(!unrecognizedColumns)parsed.data.forEach((row,i)=>{
    const date=toDateStr(row[dateHeader]??"");
    const description=(row[descHeader]??"").trim();
    let amountCents:number|null=null;
    if(amountHeader)amountCents=toCents(row[amountHeader]??"");
    else{
      const debit=debitHeader?(row[debitHeader]??"").trim():"";
      const credit=creditHeader?(row[creditHeader]??"").trim():"";
      const d=debit?toCents(debit):0,c=credit?toCents(credit):0;
      if((debit||credit)&&d!==null&&c!==null&&c>=0&&!(d!==0&&c!==0))amountCents=c-Math.abs(d);
    }
    const balance=balanceHeader?(row[balanceHeader]??"").trim():"";
    const balanceCents=balance?toCents(balance):null;
    if(!date||!description||amountCents===null||!Number.isSafeInteger(amountCents)||(balance&&balanceCents===null)){
      invalidRows.push(i+2);return;
    }
    lines.push({i,date,description,amountCents,balanceCents});
  });
  let balanceCheck:ParsedStatement["balanceCheck"]=null;
  let statementEvidence:ParsedStatement["statementEvidence"]=null;
  if(!sourceErrors&&!invalidRows.length&&lines.length>=2&&lines.every(l=>l.balanceCents!==null)){
    const check=(ordered:ParsedStatementLine[])=>{
      const openingCents=ordered[0].balanceCents!-ordered[0].amountCents;
      const closingCents=ordered.at(-1)!.balanceCents!;
      let sumCents=0, running=openingCents, ok=Number.isSafeInteger(openingCents);
      ordered.forEach((l,i)=>{
        sumCents+=l.amountCents;running+=l.amountCents;
        ok=ok&&Number.isSafeInteger(sumCents)&&Number.isSafeInteger(running)&&running===l.balanceCents&&
          (i===0||ordered[i-1].date<=l.date);
      });
      return {openingCents,closingCents,sumCents,ok};
    };
    const reverse=[...lines].reverse(), forward=check(lines), backward=check(reverse);
    const ordered=forward.ok?lines:reverse;
    balanceCheck=forward.ok?forward:backward.ok?backward:forward;
    if(balanceCheck.ok&&(!forward.ok||!backward.ok||forward.closingCents===backward.closingCents)){
      statementEvidence={from:ordered[0].date,to:ordered.at(-1)!.date,openingCents:balanceCheck.openingCents,
        closingCents:balanceCheck.closingCents,transactions:ordered.map(l=>({i:l.i,date:l.date,amountCents:l.amountCents,balanceCents:l.balanceCents!}))};
    }
  }
  return {lines,balanceCheck,unrecognizedColumns,invalidRows,sourceErrors,statementEvidence};
}

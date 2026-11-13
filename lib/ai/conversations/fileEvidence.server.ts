import "server-only";
import Papa from "papaparse";
import * as XLSX from "xlsx";

/** Untrusted source excerpts: never execute content, formulas, or file-origin instructions. */
export type FileEvidence={text:string;truncated:boolean};
const MAX_EXCERPT=48_000;
const MAX_INFLATED=16*1024*1024;
const MAX_SHEETS=8;
const MAX_ROWS=80;
const MAX_COLUMNS=32;
function excerpt(text:string,truncated=false):FileEvidence{
 return {text:text.slice(0,MAX_EXCERPT),truncated:truncated||text.length>MAX_EXCERPT};
}
function validUtf8(bytes:Uint8Array):string{
 const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
 if(text.includes("\u0000"))throw new Error("unsupported_text_encoding");
 return text;
}
/** Reject ZIP64, missing central directory, and oversized expanded XLSX before SheetJS inflation. */
export function assertSafeWorkbook(bytes:Uint8Array):void{
 if(bytes.length<22||bytes[0]!==0x50||bytes[1]!==0x4b)throw new Error("invalid_xlsx");
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let count=0,total=0,offset=0;
 while(offset+46<=bytes.length){
  if(view.getUint32(offset,true)!==0x02014b50){offset++;continue;}
  const compressed=view.getUint32(offset+20,true),expanded=view.getUint32(offset+24,true);
  const name=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true);
  const end=offset+46+name+extra+comment;
  if(end>bytes.length||expanded===0xffffffff||compressed===0xffffffff)throw new Error("unsupported_xlsx");
  total+=expanded;count++;
  if(total>MAX_INFLATED||count>1000)throw new Error("workbook_too_large");
  offset=end;
 }
 if(count===0)throw new Error("invalid_xlsx");
}
export function fileEvidence(mimeType:string,bytes:Uint8Array,name:string):FileEvidence{
 if(bytes.length===0||bytes.length>2097152)throw new Error("invalid_file_size");
 if(mimeType==="text/plain"){
  const text=validUtf8(bytes);
  return excerpt("File "+name+" (untrusted text, original line numbers):\n"+text);
 }
 if(mimeType==="text/csv"){
  const text=validUtf8(bytes).replace(/^\uFEFF/u,"");
  const parsed=Papa.parse<string[]>(text,{preview:MAX_ROWS+1,skipEmptyLines:"greedy",dynamicTyping:false});
  if(parsed.errors.some(e=>e.code!=="TooManyFields"&&e.code!=="TooFewFields"))
    throw new Error("csv_parse_failed");
  const rows=parsed.data;
  const lines=rows.slice(0,MAX_ROWS).map((row,i)=>
   "Record "+(i+1)+" (not physical line): "+row.slice(0,MAX_COLUMNS).map((value,j)=>
    XLSX.utils.encode_col(j)+"="+JSON.stringify(value.slice(0,300))).join(" | "));
  return excerpt("CSV "+name+"; source records, column letters; quoted records may span physical lines:\n"+
   lines.join("\n"),rows.length>MAX_ROWS||lines.some((_,i)=>rows[i].length>MAX_COLUMNS));
 }
 if(mimeType==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"){
  assertSafeWorkbook(bytes);
  let workbook:XLSX.WorkBook;
  try{workbook=XLSX.read(bytes,{type:"buffer",sheetRows:MAX_ROWS,cellFormula:false,cellStyles:false,bookVBA:false});}
  catch{throw new Error("xlsx_parse_failed");}
  let truncated=workbook.SheetNames.length>MAX_SHEETS;
  const lines:string[]=["Workbook "+name+"; formulas are not evaluated; saved values may be stale."];
  for(const [i,sheetName] of workbook.SheetNames.entries()){
   if(i>=MAX_SHEETS)break;
   const visibility=workbook.Workbook?.Sheets?.[i]?.Hidden??0;
   if(visibility!==0){lines.push("Sheet "+(i+1)+" hidden: omitted");continue;}
   const sheet=workbook.Sheets[sheetName];
   if(!sheet?.["!ref"]){lines.push("Sheet "+(i+1)+" "+JSON.stringify(sheetName)+" empty");continue;}
   const range=XLSX.utils.decode_range(sheet["!ref"]);
   truncated||=(range.e.r-range.s.r+1)>MAX_ROWS||(range.e.c-range.s.c+1)>MAX_COLUMNS;
   lines.push("Sheet "+(i+1)+" "+JSON.stringify(sheetName));
   for(let row=range.s.r;row<=Math.min(range.e.r,range.s.r+MAX_ROWS-1);row++){
    const cells:string[]=[];
    for(let col=range.s.c;col<=Math.min(range.e.c,range.s.c+MAX_COLUMNS-1);col++){
     const ref=XLSX.utils.encode_cell({r:row,c:col});
     const cell=sheet[ref];if(!cell||cell.v===undefined)continue;
     const value=String(cell.v).slice(0,300);
     cells.push(ref+"="+JSON.stringify(value)+(cell.f?" [formula cache; unverified]":""));
    }
    if(cells.length)lines.push(cells.join(" | "));
   }
  }
  return excerpt(lines.join("\n"),truncated);
 }
 throw new Error("unsupported_document_type");
}

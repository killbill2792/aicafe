/** A deterministic response-shape contract. Calculation evidence remains in the
 * trusted `how` block; don't turn model-written arithmetic into a new formula. */
export function compactCalculationReply(reply:string):string {
 const sentences=reply.trim()
  .split(/(?:\r?\n)+|(?<=[.!?؟。])\s+(?=\S)/u)
  .map(value=>value.trim()).filter(Boolean);
 if(sentences.length===0)return "";
 const chunks=sentences.flatMap(sentence=>{
  if(sentence.length<=180)return [sentence];
  // Separate a long explanatory sentence at clause boundaries; do not cut a
  // currency or decimal token in half.
  const parts=sentence.split(/(?<=;|؛)\s+|\s+[—–]\s+/u).map(x=>x.trim()).filter(Boolean);
  return parts.length>1?parts:[sentence];
 });
 // The answer/number is first; preserve a next-step or warning if one exists.
 // The tool's complete verified working stays available in the collapsed how block.
 const next=chunks.findLastIndex((s,i)=>i>0&&
   /(?:\b(?:next|try|consider|ask|check|confirm|record|update|need|missing|estimate|warning|approve)\b|siguiente|recomiendo|verifica|confirma|falta|estimad|الخطوة|تحقق|تأكيد|ناقص|تقدير|couldn.t read|could not read|unable to read|no pude consultar|no pude leer|تعذرت قراءة|تعذر قراءة)/iu.test(s));
 const selected=chunks.slice(0,3);
 if(next>=3)selected[2]=chunks[next];
 return selected.map(s=>{
  if(s.length<=180)return s;
  const cutoff=s.lastIndexOf(" ",178);
  return s.slice(0,cutoff>70?cutoff:180).trimEnd()+"…";
 }).join("\n");
}

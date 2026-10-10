/** Browser speech events may contain interim and final chunks. Do not send interim
 * recognition to the server, and do not replace owner-typed text with partials. */
export function speechChunks(results: ArrayLike<ArrayLike<{transcript:string}> & {isFinal?:boolean}>):
  {final:string;interim:string} {
  const final: string[] = [], interim: string[] = [];
  for(const result of Array.from(results)){
    const text = result[0]?.transcript?.trim();
    if (!text) continue;
    (result.isFinal === false ? interim : final).push(text);
  }
  return {final:final.join(" ").trim(),interim:interim.join(" ").trim()};
}
export function appendSpeech(base:string, spoken:string):string {
  return [base.trim(),spoken.trim()].filter(Boolean).join(" ").slice(0,4000);
}

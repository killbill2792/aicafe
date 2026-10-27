/** Redact sensitive values before an exception reaches a durable audit row or log.
 * Preserve the failing operation/column while never retaining credentials or PII. */
export function redactToolFailure(error:unknown,code:string,max=300):string{
 const raw=error instanceof Error?error.message:String(error);
 const safe=raw
  .replace(/Bearer\s+\S+/giu,"Bearer [redacted]")
  .replace(/(?:access_token|refresh_token|client_secret|api_key|authorization|password|cookie)\s*[:=]\s*[^\s,;]+/giu,"credential=[redacted]")
  .replace(/https?:\/\/[^\s]+/giu,"[url redacted]")
  .replace(/\b(?:name|email|phone|ssn|account(?:_number)?|bank_line)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,"personal=[redacted]")
  .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,"[email redacted]")
  .replace(/(?:\+?\d[\d\s()\-]{8,}\d)/gu,"[phone redacted]")
  .replace(/\b[A-Za-z0-9_\-]{30,}\b/gu,"[redacted]")
  .replace(/[\r\n\t]+/gu," ").trim();
 return (code+": "+safe).slice(0,max);
}
/** Stack messages repeat exception payloads; retain only source frames to
 * avoid recording any prompt, token, phone, receipt or SQL parameter value. */
export function redactedErrorStack(error:unknown):string|null{
 if(!(error instanceof Error)||!error.stack)return null;
 const frames=error.stack.split("\n").slice(1)
  .filter(line=>line.trimStart().startsWith("at "))
  .slice(0,8).map(line=>redactToolFailure(line,"frame",280));
 return frames.length?frames.join("\n").slice(0,2200):null;
}

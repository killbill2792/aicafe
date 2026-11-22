/** Pure admission predicate for a saved, same-thread owner answer candidate.
 * External/connector text never becomes owner evidence without the exact
 * authenticated durable job and its live checkpoint. Does NOT approve effects. */
export function allowPendingStaffQuestionRead(input:{
  external:boolean;
  ownerRole:string; ownerContentType:string; ownerInputResponse:boolean;
  ownerText:string; ownerId:string; ownerThreadId:string; threadId:string;
  durableFence:{jobId:string}|null;
  hasCheckpoint:boolean;
  job:{id:string;ownerMessageId:string;threadId:string}|null;
}):boolean{
  if(input.ownerRole!=="owner"||input.ownerContentType!=="text"||
     input.ownerThreadId!==input.threadId||input.ownerInputResponse||
     !input.ownerText.trim())return false;
  if(!input.external)return true;
  return Boolean(input.durableFence&&input.hasCheckpoint&&input.job&&
    input.durableFence.jobId===input.job.id&&
    input.job.ownerMessageId===input.ownerId&&input.job.threadId===input.threadId);
}

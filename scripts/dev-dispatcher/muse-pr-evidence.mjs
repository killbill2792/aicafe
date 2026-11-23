// GitHub observation only. Never authorizes, schedules, or recommends an effect.
// Keep source comments discoverable; classifications only filter the owner's inbox.
const trusted=a=>['OWNER','MEMBER','COLLABORATOR'].includes(a);
const safeUrl=(url,pr)=>typeof url==='string'&&url.startsWith(pr.url+'#issuecomment-')&&
 /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#issuecomment-\d+$/.test(url);
const text=s=>String(s||'').replace(/<!--[^]*?-->/g,'').trim();
const preview=s=>text(s).replace(/\s+/g,' ').slice(0,1600);
const ownerWords=/\b(?:please\s+(?:explicitly\s+)?(?:approve|authorize|confirm|decide|choose|review and approve|run workflow)|(?:owner|your)\s+(?:approval|authorization|decision|action|sign[- ]?off|input)\s+(?:is\s+)?(?:required|needed|requested)|(?:request|need|requires?)\s+(?:an?\s+)?(?:owner|your)\s+(?:approval|authorization|decision)|(?:action|required|decision)\s+(?:from|for)\s+(?:the\s+)?owner|do you approve|approval required|owner decision needed|single remaining execution action|required owner action|owner action required|(?:owner|authenticated user|you)\s+(?:must|need to|needs to|should)\s+(?:select|run|click|configure|approve|authorize|confirm))\b/i;
const nonRequest=/\b(?:no (?:new |further |additional )?(?:owner )?(?:approval|decision) (?:required|needed|requested)|not (?:an? )?(?:owner )?(?:approval|authorization) request|approval (?:was |has been )?(?:received|recorded|granted)|owner (?:has )?approved|already approved|approved in (?:the )?(?:owner|originating) chat)\b/i;
const postMerge=/\b(?:luna\s+authorization|(?:paid|bounded)\s+luna\s+(?:run|test|scenario)|(?:post|trigger|run)\s+\/aicafe-luna|approve|authorize|run|trigger|apply|configure|enable|provision|grant)\s+(?:(?:the|an?|one|existing|bounded)\s+){0,4}(?:production|deployment|release|live|paid|workflow|migration|secret|credential|environment)\b|\b(?:luna authorization|production migration|live model|paid execution|deployment|release)\s*:\s*(?:task|scenario|run|approval)\b|\b(?:production migration|live model|paid execution|deployment|release)\s+(?:approval|authorization)\s+(?:requested|required|needed)\b|\b(?:action required|single remaining execution action)[\s\S]{0,120}(?:run workflow|workflow_dispatch|production|migration|\/aicafe-luna)\b/i;
const requestMarker=/^<!-- aicafe-owner-request:v1 ([a-f0-9]{40}) -->\s*/;
const reportMarker=/^<!-- aicafe-integration-result:v1 (\{[^\n]{1,3500}\}) -->/;

// Durable PR-scoped coordination receipts. These are delivery/attention state,
// never owner approval or permission to execute development or production work.
const ackMarker=/^<!-- aicafe-owner-state:v1 (\{[^\n]{1,450}\}) -->/;
const ackStates=new Set(['acknowledged','answered','delivery_uncertain','delivered','ignored','resolved','reopened']);
function readAck(c,allowed){
 if(!allowed.has(c.author?.login))return null;
 const match=String(c.body||'').match(ackMarker);if(!match)return null;
 try{
  const payload=JSON.parse(match[1]);
  if(payload.v!==1||!/^comment-[1-9]\d{0,19}$/.test(payload.question_id)||
     !/^comment-[1-9]\d{0,19}-r[1-9]\d{0,9}(?:-[a-f0-9]{16})?$/.test(payload.event_id)||
     !payload.event_id.startsWith(payload.question_id+'-r')||
     !ackStates.has(payload.state))return null;
  return {question_id:payload.question_id,event_id:payload.event_id,state:payload.state,
   sequence:Number(payload.event_id.match(/-r([1-9]\\d*)/)[1]),
   url:c.url,created_at:c.createdAt,actor:c.author.login,
   comment_id:Number(String(c.url).split('#issuecomment-').at(-1))};
 }catch{return null;}
}

const statusWords=/\b(?:PROVEN|FAILED|NOT_PROVEN|BLOCKED|ACTION_REQUIRED)\b/;
// Only an explicit, affirmative disposition line may close an existing request.
// Free-form "approved request #..." is not safe: "not approved request #..." is common.
const reference=/^(?:resolves?|resolved|supersedes?|superseded|answered|closing)\s+(?:owner\s+)?(?:request\s+|question\s+|comment\s+)?(?:#issuecomment-|#)?(\d{7,20})\b/i;
function resolutions(body){
 const found=[];let superseded=false;
 for(const line of String(body||'').split('\n')){
  const trimmed=line.trim().replace(/^(?:[-*]\s+)?/,'');
  if(/^(?:not|no|never|without|unresolved|don't|cannot|can't)\b/i.test(trimmed))continue;
  const m=trimmed.match(reference);
  if(m){found.push('comment-'+m[1]);if(/^super(?:sede|sedes|seded)/i.test(trimmed))superseded=true;}
 }
 return {ids:[...new Set(found)],superseded};
}
function report(c,pr){
 const s=String(c.body||'');const m=s.match(reportMarker);
 if(m){
  try{
   const r=JSON.parse(m[1]);
   if(!/^[a-f0-9]{40}$/.test(r.merge_sha||'')||!['PROVEN','FAILED','NOT_PROVEN','BLOCKED','ACTION_REQUIRED'].includes(r.status))return null;
   return {source_comment_id:'comment-'+String(c.url||'').split('#issuecomment-').at(-1),source_url:c.url,merge_sha:r.merge_sha,
    status:r.status,summary:preview(s),evidence_urls:Array.isArray(r.evidence_urls)?
     r.evidence_urls.filter(u=>typeof u==='string'&&u.startsWith('https://github.com/')).slice(0,20):[],
    source:'chatgpt_pr_report',independently_verified:false};
  }catch{return null;}
 }
 if(/\b(?:post.merge integration (?:receipt|acceptance|proof)|integration acceptance (?:result|report))\b/i.test(s)&&statusWords.test(s))
  return {source_comment_id:'comment-'+c.id,source_url:c.url,merge_sha:pr.mergeCommit?.oid||null,
   status:'NOT_PROVEN',summary:preview(s),evidence_urls:[],
   source:'unstructured_comment',independently_verified:false};
 return null;
}
export function inspectPrComments(pr,repo,{merged=false,ackAuthors=[]}={}){
 const result={comments:[],owner_requests:[],ack_events:[],handling:[],resolved_request_ids:[],integration_reports:[],
  attention:[],owner_request_read_incomplete:pr.comments?.pageInfo?.hasPreviousPage!==false||
   !Array.isArray(pr.comments?.nodes),unresolved_review_threads:[],review_scan_incomplete:
   !Array.isArray(pr.reviewThreads?.nodes)||pr.reviewThreads?.pageInfo?.hasNextPage!==false};
 if(pr.headRepository?.nameWithOwner!==repo&&!(merged&&!pr.headRepository))return result;
 const resolved=new Set(),superseded=new Set(),sourceResolution=new Map();
 const ackAllowed=new Set([repo.split('/')[0],...ackAuthors].filter(Boolean));
 for(const c of pr.comments?.nodes||[]){
  const body=String(c.body||''),id=String(c.url||'').match(/#issuecomment-(\d+)$/)?.[1];
  if(!id||!safeUrl(c.url,pr))continue;
  const verified=trusted(c.authorAssociation)&&!!c.author?.login&&!c.author.login.endsWith('[bot]');
  const value={id:'comment-'+id,url:c.url,created_at:c.createdAt,author:c.author?.login||null,
   summary:preview(body),trusted:verified,kind:'information'};
  result.comments.push(value);
  const ack=readAck(c,ackAllowed);
  if(ack){result.ack_events.push(ack);value.kind='coordination_receipt';continue;}
  // Never classify a coordination receipt as a new owner question, including
  // receipts from an untrusted author (which must not change any owner state).
  if(body.startsWith('<!-- aicafe-owner-state:v1 '))continue;
  if(!verified)continue;
  const mark=body.match(requestMarker),stripped=text(body);
  const explicit=!!mark,asked=ownerWords.test(stripped)&&!(nonRequest.test(stripped)&&
   !/\b(?:please\s+(?:approve|authorize|confirm)|do you approve|owner decision needed)\b/i.test(stripped));
  if(explicit||asked){
   const kind=postMerge.test(stripped)?'release_or_live_approval':'development_question';
   const q={id:value.id,pr_number:pr.number,head_sha:mark?.[1]||pr.headRefOid||pr.mergeCommit?.oid,
    head_bound:!!mark,
    question:stripped.slice(0,2000),url:c.url,author:value.author,created_at:c.createdAt,
    classification:kind,source:explicit?'marked':'inferred_from_text'};
   result.owner_requests.push(q);
   value.kind='owner_request';
  }
  const rep=report({...c,id,url:c.url},pr);
  if(rep){result.integration_reports.push(rep);value.kind='integration_report';}
  const links=resolutions(body);
  // Only exact, distinct source-comment references can close a request.
  // Unlinked "owner approved" sentences are informational, never an approval.
  if(value.kind!=='owner_request')for(const l of links.ids){
   resolved.add(l);sourceResolution.set(l,c.url);
   if(links.superseded)superseded.add(l);
  }
 }
  result.resolved_request_ids=[...resolved];
 const duplicates=new Map();
 for(const q of [...result.owner_requests].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||
  Number(a.id.slice(8))-Number(b.id.slice(8)))){
  const key=[q.head_sha,q.classification,q.question.toLowerCase().replace(/\s+/g,' ').replace(/[?.!]+$/,'').trim()].join('::');
  const previous=duplicates.get(key);
  if(previous)q.duplicate_of=previous;
  else duplicates.set(key,q.id);
 }
 const ackByQuestion=new Map();
 for(const event of result.ack_events.sort((a,b)=>a.comment_id-b.comment_id))
  ackByQuestion.set(event.question_id,event);
 for(const q of result.owner_requests){
  // A developer's "resolved" sentence is not sufficient to dismiss a
  // production, migration or paid-run grant. Only authenticated courier/owner
  // disposition can remove those from the attention inbox.
  const finished=resolved.has(q.id)&&q.classification!=='release_or_live_approval';
  const beforeMerge=merged&&pr.mergedAt&&Date.parse(q.created_at)<=Date.parse(pr.mergedAt);
  const historical=beforeMerge&&q.classification==='development_question';
  q.disposition=finished?(superseded.has(q.id)?'superseded_reported':'resolved_reported'):
   q.duplicate_of?'duplicate_reported':
   historical?'historical_after_merge':'needs_review';
  if(finished)q.resolution_source_url=sourceResolution.get(q.id)||null;

  const ack=ackByQuestion.get(q.id);
  if(ack){q.github_ack=ack;q.coordination_state=ack.state;}
  // An explicit authenticated reopen overrides automatic merge archival;
  // an acknowledgment suppresses repeats without pretending it is approval.
  if(ack?.state==='reopened')q.disposition='needs_review';
  const handled=ack&&ack.state!=='reopened';
  if(handled)result.handling.push({id:q.id,state:ack.state,url:ack.url});
  // Closing a development PR archives old scope questions for display; not owner authorization.
  if(q.disposition==='needs_review'&&!handled)result.attention.push({
   type:'owner_question',id:q.id,pr_number:pr.number,text:q.question,
   source_url:q.url,created_at:q.created_at,classification:q.classification,
   source:q.source});
 }
 for(const t of pr.reviewThreads?.nodes||[]){
  if(t.isResolved===true)continue;
  const first=t.comments?.nodes?.[0];
  if(first)result.unresolved_review_threads.push({id:t.id,url:first.url,
   author:first.author?.login||null,summary:preview(first.body)});
 }
 return result;
}
export function readablePrSummary(pr){
 const issues=(pr.attention||[]).map(a=>a.text.replace(/\s+/g,' ').slice(0,240));
 const latest=(pr.integration_reports||[]).at(-1);
 return {pr_number:pr.number,title:pr.title,merged_at:pr.merged_at||null,
  pending_owner_requests:issues.length,requests:issues,
  unresolved_review_threads:pr.unresolved_review_threads?.length||0,
  integration:latest?{status:latest.status,verified:false,source:latest.source_url}:'NOT_REPORTED',
  comment_count:pr.comments?.length||0,
  scan_complete:pr.owner_request_read_incomplete===false&&pr.review_scan_incomplete!==true};
}

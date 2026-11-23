// GitHub observation only. Never authorizes, schedules, or recommends an effect.
// Keep source comments discoverable; classifications only filter the owner's inbox.
const trusted=a=>['OWNER','MEMBER','COLLABORATOR'].includes(a);
const safeUrl=(url,pr)=>typeof url==='string'&&url.startsWith(pr.url+'#issuecomment-')&&
 /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#issuecomment-\d+$/.test(url);
const text=s=>String(s||'').replace(/<!--[^]*?-->/g,'').trim();
const preview=s=>text(s).replace(/\s+/g,' ').slice(0,1600);
const ownerWords=/\b(?:please\s+(?:explicitly\s+)?(?:approve|authorize|confirm|decide|choose|review and approve|run workflow)|(?:owner|your)\s+(?:approval|authorization|decision|action|sign[- ]?off|input)\s+(?:is\s+)?(?:required|needed|requested)|(?:request|need|requires?)\s+(?:an?\s+)?(?:owner|your)\s+(?:approval|authorization|decision)|(?:action|required|decision)\s+(?:from|for)\s+(?:the\s+)?owner|do you approve|approval required|owner decision needed|single remaining execution action|required owner action|owner action required|(?:owner|authenticated user|you)\s+(?:must|need to|needs to|should)\s+(?:select|run|click|configure|approve|authorize|confirm))\b/i;
const nonRequest=/\b(?:no (?:new |further |additional )?(?:owner )?(?:approval|decision) (?:required|needed|requested)|not (?:an? )?(?:owner )?(?:approval|authorization) request|approval (?:was |has been )?(?:received|recorded|granted)|owner (?:has )?approved|already approved|approved in (?:the )?(?:owner|originating) chat)\b/i;
const postMerge=/\b(?:approve|authorize|run|trigger|apply|configure|enable|provision|grant)\s+(?:(?:the|an?|one|existing|bounded)\s+){0,4}(?:production|deployment|release|live|paid|workflow|migration|secret|credential|environment)\b|\b(?:production migration|live model|paid execution|deployment|release)\s+(?:approval|authorization)\s+(?:requested|required|needed)\b|\b(?:action required|single remaining execution action)[\s\S]{0,120}(?:run workflow|workflow_dispatch|production|migration)\b/i;
const requestMarker=/^<!-- aicafe-owner-request:v1 ([a-f0-9]{40}) -->\s*/;
const reportMarker=/^<!-- aicafe-integration-result:v1 (\{[^\n]{1,3500}\}) -->/;
const statusWords=/\b(?:PROVEN|FAILED|NOT_PROVEN|BLOCKED|ACTION_REQUIRED)\b/;
const reference=/\b(?:resolves?|resolved|supersedes?|superseded|addresses|answered|satisfied|approved|closing)\s+(?:owner\s+)?(?:request\s+|question\s+|comment\s+)?(?:#issuecomment-|#)?(\d{7,20})\b/gi;
function resolutions(body){
 const ids=[];for(const match of String(body||'').matchAll(reference))ids.push('comment-'+match[1]);
 return [...new Set(ids)];
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
export function inspectPrComments(pr,repo,{merged=false}={}){
 const result={comments:[],owner_requests:[],resolved_request_ids:[],integration_reports:[],
  attention:[],owner_request_read_incomplete:pr.comments?.pageInfo?.hasPreviousPage!==false||
   !Array.isArray(pr.comments?.nodes),unresolved_review_threads:[],review_scan_incomplete:
   !Array.isArray(pr.reviewThreads?.nodes)||pr.reviewThreads?.pageInfo?.hasNextPage!==false};
 if(pr.headRepository?.nameWithOwner!==repo&&!(merged&&!pr.headRepository))return result;
 const resolved=new Set(),superseded=new Set(),sourceResolution=new Map(),unlinkedApprovals=[];
 for(const c of pr.comments?.nodes||[]){
  const body=String(c.body||''),id=String(c.url||'').match(/#issuecomment-(\d+)$/)?.[1];
  if(!id||!safeUrl(c.url,pr))continue;
  const verified=trusted(c.authorAssociation)&&!!c.author?.login&&!c.author.login.endsWith('[bot]');
  const value={id:'comment-'+id,url:c.url,created_at:c.createdAt,author:c.author?.login||null,
   summary:preview(body),trusted:verified,kind:'information'};
  result.comments.push(value);
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
  const links=resolutions(body);for(const l of links){resolved.add(l);sourceResolution.set(l,c.url);}
  if(!links.length&&/\b(?:owner (?:explicitly |already |has )?approved|owner approval (?:received|recorded|granted)|approval received in (?:the )?originating chat|approved in (?:the )?(?:owner|originating) chat)\b/i.test(stripped))
   unlinkedApprovals.push({at:c.createdAt,url:c.url});
  if(/\bsupersedes?\b/i.test(body))for(const l of links)superseded.add(l);
 }
 // A source-reported approval with no comment reference can resolve only a
 // single earlier development question. More than one remains ambiguous.
 for(const reply of unlinkedApprovals.sort((a,b)=>String(a.at).localeCompare(String(b.at)))){
  const candidates=result.owner_requests.filter(q=>q.classification==='development_question'&&
   !resolved.has(q.id)&&Date.parse(q.created_at)<=Date.parse(reply.at));
  if(candidates.length===1){resolved.add(candidates[0].id);sourceResolution.set(candidates[0].id,reply.url);}
 }
 result.resolved_request_ids=[...resolved];
 for(const q of result.owner_requests){
  const finished=resolved.has(q.id);
  const beforeMerge=merged&&pr.mergedAt&&Date.parse(q.created_at)<=Date.parse(pr.mergedAt);
  const historical=beforeMerge&&q.classification==='development_question';
  q.disposition=finished?(superseded.has(q.id)?'superseded_reported':'resolved_reported'):
   historical?'historical_after_merge':'needs_review';
  if(finished)q.resolution_source_url=sourceResolution.get(q.id)||null;

  // Closing a development PR archives old scope questions for display; not owner authorization.
  if(q.disposition==='needs_review')result.attention.push({
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

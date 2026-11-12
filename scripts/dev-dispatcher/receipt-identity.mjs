#!/usr/bin/env node
// One v1 receipt filename contract shared by the trusted GitHub inbox and Muse.
// JSON.stringify(target) intentionally preserves legacy v1 target-key ordering.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function receiptFilename(receipt){
  if(!receipt||typeof receipt!=='object')throw Error('Invalid receipt');
  let identity;
  if(receipt.kind==='owner_notice'){
    if(typeof receipt.notice_id!=='string'||typeof receipt.notice_hash!=='string')
      throw Error('Invalid notice identity');
    identity='owner:'+receipt.notice_id+':'+receipt.notice_hash;
  }else if(receipt.kind==='muse_recovery'){
    if(typeof receipt.request_id!=='string'||!/^[a-f0-9]{64}$/.test(receipt.request_id)||
       receipt.event_id!==receipt.request_id||receipt.version!==1||
       typeof receipt.repo!=='string'||typeof receipt.actor!=='string')
      throw Error('Invalid Muse recovery receipt identity');
    identity='muse-recovery:'+receipt.event_id+':'+
      hash(JSON.stringify([receipt.repo,receipt.actor,receipt.intent,
        receipt.task_id,receipt.pr_number,receipt.expected_head_sha,
        receipt.requested_at]));
  }else if(['owner_reply','owner_instruction'].includes(receipt.kind)){
    if(typeof receipt.event_id!=='string'||!receipt.target||
       typeof receipt.target!=='object'||typeof receipt.text!=='string')
      throw Error('Invalid owner reply identity');
    identity=receipt.kind+':'+receipt.event_id+':'+
      JSON.stringify(receipt.target)+':'+hash(receipt.text);
  }else{
    if(typeof receipt.action_id!=='string'||typeof receipt.prompt_hash!=='string')
      throw Error('Invalid delivery identity');
    identity=receipt.action_id+':'+receipt.prompt_hash;
  }
  return hash(identity)+'.json';
}
// Muse may pipe the exact receipt JSON to this CLI before its existing SSH
// write. This tool only prints its deterministic name; it does NOT send.
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  try{console.log(receiptFilename(JSON.parse(readFileSync(0,'utf8'))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}

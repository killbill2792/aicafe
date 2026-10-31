import {createHmac} from "node:crypto";
import {describe,it,expect} from "vitest";
import {parseWebhook,verifySignature,verifyChallenge,MAX_WEBHOOK_BYTES} from "./webhook";
import {TEST_PHONE_NUMBER_ID} from "./transport";
const secret="test-only-secret";
const signature=(body:Buffer)=>"sha256="+createHmac("sha256",secret).update(body).digest("hex");
const msg=(id:string,payload:Record<string,unknown>)=>({
  from:"15556506570",id:"wamid."+id,timestamp:"1793462400",...payload,
});
function encoded(messages:unknown[],statuses:unknown[]=[],phone=TEST_PHONE_NUMBER_ID) {
  return Buffer.from(JSON.stringify({object:"whatsapp_business_account",
    entry:[{changes:[{field:"messages",value:{
      messaging_product:"whatsapp",metadata:{phone_number_id:phone},
      messages,statuses,
    }}]}]}));
}
describe("raw WhatsApp webhook",()=>{
  it("does not accept forged/re-encoded request bodies",()=>{
    const body=encoded([msg("one",{type:"text",text:{body:"Where did yesterday go?"}})]);
    expect(verifySignature(body,signature(body),secret)).toBe(true);
    expect(verifySignature(Buffer.concat([body,Buffer.from(" ")]),signature(body),secret)).toBe(false);
    expect(verifySignature(body,null,secret)).toBe(false);
    expect(verifySignature(body,"sha256=deadbeef",secret)).toBe(false);
    expect(verifySignature(body,signature(body),undefined)).toBe(false);
  });
  it("verifies GET mode, exact token and provider challenge",()=>{
    const query=new URLSearchParams({"hub.mode":"subscribe","hub.verify_token":"verify-xyz","hub.challenge":"1234567"});
    expect(verifyChallenge(query,"verify-xyz")).toBe("1234567");
    expect(verifyChallenge(query,"verify-ABC")).toBeNull();
    expect(verifyChallenge(query,undefined)).toBeNull();
    query.set("hub.mode","unsubscribe");
    expect(verifyChallenge(query,"verify-xyz")).toBeNull();
  });
  it("parses every message and status across changes independently, preserving payload not label",()=>{
    const first=encoded([
      msg("plain",{type:"text",text:{body:"How was today?"}}),
      msg("button",{type:"button",button:{payload:"money_went",text:"not the canonical label"}}),
      msg("interactive",{type:"interactive",interactive:{type:"button_reply",
        button_reply:{id:"slowest_yesterday",title:"renamed by provider"}}}),
      msg("picture",{type:"image",image:{id:"media-image-1"}}),
      msg("pdf",{type:"document",document:{id:"media-pdf-1"}}),
    ],[{id:"wamid.outgoing",status:"delivered"}]);
    const second={object:"whatsapp_business_account",entry:[{changes:[
      JSON.parse(first.toString()).entry[0].changes[0],
      {field:"messages",value:{metadata:{phone_number_id:TEST_PHONE_NUMBER_ID},
        statuses:[{id:"wamid.other",status:"read"}]}},
    ]}]};
    const parsed=parseWebhook(Buffer.from(JSON.stringify(second)),TEST_PHONE_NUMBER_ID);
    expect(parsed.map(e=>e.type==="status"?e.state:e.kind))
      .toEqual(["text","button","button","image","document","delivered","read"]);
    expect(parsed[1]).toMatchObject({kind:"button",payload:"money_went",waId:"15556506570"});
    expect(parsed[2]).toMatchObject({kind:"button",payload:"slowest_yesterday"});
    expect(parsed[3]).toMatchObject({kind:"image",mediaId:"media-image-1"});
    expect(parsed[4]).toMatchObject({kind:"document",mediaId:"media-pdf-1"});
  });
  it("rejects wrong sender, unknown button, malformed timestamp and excessive bytes",()=>{
    expect(()=>parseWebhook(encoded([msg("a",{type:"text",text:{body:"X"}})],[],"111111111"),TEST_PHONE_NUMBER_ID))
      .toThrow("wrong_sender");
    expect(()=>parseWebhook(encoded([msg("a",{type:"button",button:{payload:"unknown"}})]),TEST_PHONE_NUMBER_ID))
      .toThrow("unsupported_event");
    expect(()=>parseWebhook(encoded([msg("a",{type:"text",text:{body:"X"},timestamp:"not-a-date"})]),TEST_PHONE_NUMBER_ID))
      .toThrow("malformed_event");
    expect(()=>parseWebhook(Buffer.alloc(MAX_WEBHOOK_BYTES+1),TEST_PHONE_NUMBER_ID))
      .toThrow("invalid_size");
  });
});

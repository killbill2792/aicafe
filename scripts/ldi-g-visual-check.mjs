import {chromium} from "playwright";
import {mkdirSync,readFileSync} from "node:fs";
import {join} from "node:path";
import assert from "node:assert/strict";

const base=process.env.EVENTS_FIXTURE_URL??"http://127.0.0.1:3000";
const out="test-results/ldi-g-events";
mkdirSync(out,{recursive:true});
const translations=Object.fromEntries(["en","es","ar"].map(locale=>
  [locale,JSON.parse(readFileSync("messages/"+locale+".json","utf8")).EventsPanel]));
const today="2026-11-03", day="2026-11-04";
const cafeId="11111111-1111-4111-8111-111111111111";
const extraId="22222222-2222-4222-8222-222222222222";
const cityId=i=>String(i).padStart(8,"0")+"-1111-4111-8111-111111111111";
const checkedAt="2026-11-03T08:00:00Z";
const cities=Array.from({length:61},(_,i)=>({
  id:cityId(i),name:i===37?"Civic Expo 37":"City Event "+i,
  kind:i%3===0?"conference":"community",startDate:day,endDate:day,
  startTime:"10:00",endTime:"16:00",timeSourceUrl:"https://city.example.org/time/"+i,
  venue:"Civic Hall",venueAddress:"1 Main St, Metro",checkedAt,
  sources:[{url:"https://city.example.org/event/"+i,observedAt:checkedAt}],
  cafeEventId:i===37?cafeId:null,
  status:i===12?"cancelled":i===37?"found":null,lastVerifiedAt:i===37?checkedAt:null,
}));
const event=(id,name)=>({
  id,name,kind:"community",startDate:day,endDate:day,
  startTime:"10:00",endTime:"16:00",venue:"Civic Hall",venueAddress:"1 Main St",
  areaLabel:null,sourceUrl:"https://city.example.org/event/37",status:"found",
  foundAt:checkedAt,lastCheckedAt:checkedAt,lastVerifiedAt:checkedAt,
});
const timeline={
  today,currency:"USD",
  events:[event(cafeId,"Civic Expo 37"),event(extraId,"Unselected Public Gathering")],
  plans:[{
    proposalId:"33333333-3333-4333-8333-333333333333",
    threadId:"44444444-4444-4444-8444-444444444444",
    status:"draft",revision:1,startDate:day,endDate:day,eventIds:[cafeId],
    summary:"Supervisor: check the possible afternoon traffic; this is not a sales forecast.",
    importance:"medium",actions:[],expectedBusyHours:[],
    factsHash:"fixture-hash",reportStatus:null,report:null,
  }],
  cityCatalog:null,
  cityCoverage:{status:"partial",researchedSourceWindows:5,successfulSourceWindows:4,
    failedSourceWindows:1,partialSourceWindows:0,unsearchedSourceWindows:0,
    lastCompletedAt:checkedAt},
  neighborhoodCoverage:[],neighborhood:[],
};
function response(url){
  const search=new URL(url).searchParams;
  const kind=search.get("cityKind"),query=search.get("citySearch")?.toLowerCase();
  const page=Number(search.get("cityPage")??0);
  const size=Number(search.get("cityPageSize")??50);
  const records=cities.filter(item=>(!kind||item.kind===kind)&&
    (!query||item.name.toLowerCase().includes(query)));
  return {...timeline,cityCatalog:{available:true,missing:null,page,pageSize:size,
    total:records.length,hasMore:(page+1)*size<records.length,
    items:records.slice(page*size,(page+1)*size)}};
}
async function click(page,selector){
  await selector.waitFor({state:"visible",timeout:30000});
  await selector.click();
}
const configs=[["en",390,844],["en",1440,900],["es",390,844],
  ["es",1440,900],["ar",390,844],["ar",1440,900]];
const browser=await chromium.launch({headless:true,channel:"chrome"});
const errors=[];
try{
 for(const [locale,width,height] of configs){
  const key=locale+"-"+width, t=translations[locale];
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1,
    locale,timezoneId:"America/Los_Angeles",reducedMotion:"reduce"});
  const observations=[];
  let mockedReads=0;
  page.on("pageerror",error=>observations.push("pageerror: "+error.message));
  page.on("response",resp=>{if(resp.url().includes("/api/events/saved"))
    observations.push("events response: "+resp.status());});
  await page.route(/\/api\/events\/saved(?:\?.*)?$/,route=>{
    mockedReads++;
    return route.fulfill({
      status:200,contentType:"application/json",body:JSON.stringify(response(route.request().url())),
    });
  });
  try{
   const nav=await page.goto(base+"/"+locale+"?fixture=events",{waitUntil:"networkidle",timeout:90000});
   assert.equal(nav.status(),200,key+" fixture route");
   await page.locator('[data-testid="coming-up"]').waitFor({state:"visible",timeout:30000});
   // A public discovery with no selected plan is NOT a café recommendation.
   assert.equal(await page.getByText("Unselected Public Gathering").count(),0,key+" raw event leaked");
   await page.getByText("Supervisor: check the possible afternoon traffic;",{exact:false})
     .first().waitFor({state:"visible",timeout:30000});
   assert.ok(mockedReads>0,key+" fixture did not intercept the saved Events API");
   await page.screenshot({path:join(out,key+"-cafe-home.png"),animations:"disabled"});
   await click(page,page.locator('[data-testid="coming-up"] button').first());
   const dialog=page.getByRole("dialog");
   await dialog.waitFor({state:"visible"});
   assert.equal(await dialog.getAttribute("dir"),locale==="ar"?"rtl":"ltr");
   await click(page,dialog.getByRole("button",{name:t.allCityEvents}));
   const catalog=page.locator('[data-testid="city-events-catalog"]');
   await catalog.waitFor({state:"visible"});
   await catalog.locator("ul > li").first().waitFor();
   assert.equal(await catalog.locator("ul > li").count(),25,key+" first page");
   assert.equal(await page.getByTestId("events-visual-handoff").count(),0,key+" auto-sent");
   await page.screenshot({path:join(out,key+"-city-page1.png"),animations:"disabled"});
   await click(page,catalog.getByRole("button",{name:t.nextPage}));
   await catalog.getByText("Civic Expo 37").waitFor();
   assert.equal(await catalog.locator("ul > li").count(),25,key+" second page");
   await click(page,catalog.getByRole("button").filter({hasText:"Civic Expo 37"}));
   const detail=page.locator('[data-testid="city-event-detail"]');
   await detail.waitFor({state:"visible"});
   assert.ok(await detail.getByText("Civic Hall").count()>0);
   assert.ok(await detail.locator('a[href="https://city.example.org/event/37"]').count()>0);
   await page.screenshot({path:join(out,key+"-city-detail.png"),animations:"disabled"});
   await click(page,detail.getByRole("button",{name:t.askCitySupervisor}));
   const handoff=JSON.parse(await page.getByTestId("events-visual-handoff").innerText());
   assert.equal(handoff.cityEventId,cityId(37),key+" exact city ID");
   assert.equal(handoff.eventId,cafeId,key+" existing café thread");
   assert.ok(handoff.draftPrompt?.includes("Civic Expo 37"),key+" localized intent");
   // The city-only tab must never persist when a café-day card is opened.
   await click(page,page.locator('[data-testid="coming-up"] button').first());
   await click(page,page.getByRole("dialog").getByRole("button",{name:t.allCityEvents}));
   await click(page,page.getByRole("dialog").getByRole("button",{name:t.close}));
   await click(page,page.locator('[data-testid="coming-up"] button').filter({hasText:"Civic Expo 37"}).first());
   await page.getByRole("dialog").waitFor({state:"visible"});
   assert.equal(await page.locator('[data-testid="city-events-catalog"]').count(),0,
     key+" stale city view after opening café day");
   assert.ok(await page.getByRole("dialog").getByText("Supervisor: check the possible afternoon traffic;",{exact:false}).count()>0);
   await page.screenshot({path:join(out,key+"-cafe-day.png"),animations:"disabled"});
   // Root and dialog must not leak horizontal overflow at a 390px viewport.
   const metrics=await page.evaluate(()=>({body:document.documentElement.scrollWidth,
     dialog:document.querySelector('[role="dialog"]')?.clientWidth,
     dialogScroll:document.querySelector('[role="dialog"]')?.scrollWidth,
   }));
   assert.ok(metrics.body<=width+3,key+" horizontal page overflow "+JSON.stringify(metrics));
   assert.ok((metrics.dialogScroll??0)<=(metrics.dialog??0)+3,
     key+" horizontal dialog overflow "+JSON.stringify(metrics));
   console.log("PASS Events "+key+" (café selection, city pagination, sources, exact chat, RTL)");
  }catch(error){
    const shown=await page.locator('[data-testid="coming-up"]').allTextContents().catch(()=>[]);
    errors.push(key+": "+(error?.stack??String(error))+"\nmockedReads="+mockedReads+
      " screen="+JSON.stringify(shown)+" diagnostics="+JSON.stringify(observations));
  }
  finally{await page.close();}
 }
}finally{await browser.close();}
if(errors.length)throw new Error("LDI G browser acceptance failed:\n"+errors.join("\n\n"));

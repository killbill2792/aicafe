import {describe,expect,it} from "vitest";
import {canonicalSourceUrl,cityEventIdentity,cityPlaceIdentity,cityScopeKey} from "./cityEventIdentity";

const scope={city:"Berkeley",region:"CA",countryCode:"US"};
const base={...scope,name:"Café Jazz & Art Night",kind:"community" as const,
  startDate:"2026-11-07",endDate:"2026-11-07",
  venue:"Downtown Plaza",venueAddress:"100 Center St",
  sourceUrl:"https://city.example/events/jazz?utm_source=mail&id=7"};

describe("shared city identity",()=>{
  it("reconciles accent, punctuation, whitespace, case and tracking changes across sources",()=>{
    const a=cityEventIdentity(base);
    const b=cityEventIdentity({...base,name:"  Cafe Jazz and Art-Night! ",
      venue:"Downtown Plaza",sourceUrl:"https://venue.example/jazz"});
    expect(a.identityKey).toBe(b.identityKey);
    expect(a.cityKey).toBe("us|ca|berkeley");
    expect(a.sourceUrl).toBe("https://city.example/events/jazz?id=7");
    expect(a.name).toBe(base.name);
  });
  it("does not merge similar events at distinct venues, on other dates, or in another city",()=>{
    const key=cityEventIdentity(base).identityKey;
    expect(cityEventIdentity({...base,venueAddress:"101 Center St"}).identityKey).not.toBe(key);
    expect(cityEventIdentity({...base,startDate:"2026-11-08",endDate:"2026-11-08"}).identityKey).not.toBe(key);
    expect(cityEventIdentity({...base,city:"Oakland"}).identityKey).not.toBe(key);
    expect(cityEventIdentity({...base,name:"Jazz and Art Night"}).identityKey).not.toBe(key);
  });
  it("retains distinct named halls at the same street address",()=>{
    const hallOne=cityEventIdentity({...base,name:"Community Open Day",venue:"Central Hall"});
    const hallTwo=cityEventIdentity({...base,name:"Community Open Day",venue:"West Hall"});
    expect(hallOne.identityKey).not.toBe(hallTwo.identityKey);
    expect(hallOne.venueIdentityKey).not.toBe(hallTwo.venueIdentityKey);
  });
  it("keeps its source anchor stable through unknown, named and addressed venue enrichment",()=>{
    const unknown=cityEventIdentity({...base,venue:null,venueAddress:null});
    const named=cityEventIdentity({...base,venueAddress:null});
    const complete=cityEventIdentity(base);
    expect(unknown.sourceIdentityKey).toBe(named.sourceIdentityKey);
    expect(named.sourceIdentityKey).toBe(complete.sourceIdentityKey);
    expect(unknown.venueIdentityKey).toBeNull();
    expect(named.venueIdentityKey).toBeNull();
    expect(complete.venueIdentityKey).not.toBeNull();
  });
  it("refuses to fuse unknown-venue city listings from independent sources",()=>{
    const one=cityEventIdentity({...base,venue:null,venueAddress:null,sourceUrl:"https://a.example/agenda"});
    const two=cityEventIdentity({...base,venue:null,venueAddress:null,sourceUrl:"https://b.example/agenda"});
    expect(one.identityKey).not.toBe(two.identityKey);
  });
  it("keeps stable keys when mutable category/end-date/source change at the same venue",()=>{
    const key=cityEventIdentity(base).identityKey;
    expect(cityEventIdentity({...base,kind:"festival",endDate:"2026-11-08",
      sourceUrl:"https://organizer.example/program"}).identityKey).toBe(key);
  });
  it("normalizes URL parameters without stripping meaningful event selectors",()=>{
    expect(canonicalSourceUrl("https://EVENTS.example/calendar/?id=30&utm_campaign=x&b=2#top"))
      .toBe("https://events.example/calendar?b=2&id=30");
    expect(canonicalSourceUrl("https://events.example/calendar?id=31"))
      .not.toBe(canonicalSourceUrl("https://events.example/calendar?id=30"));
  });
  it("rejects unsupported dates, unsafe links and incomplete city identity",()=>{
    expect(()=>cityEventIdentity({...base,startDate:"2026-02-30"})).toThrow();
    expect(()=>cityEventIdentity({...base,endDate:"2026-11-06"})).toThrow();
    expect(()=>cityEventIdentity({...base,sourceUrl:"javascript:alert(1)"})).toThrow();
    expect(()=>cityScopeKey({...scope,region:""})).toThrow();
    expect(()=>cityScopeKey({...scope,countryCode:"US-CA"})).toThrow();
  });
});
describe("shared neighborhood place identity",()=>{
  it("shares public place facts in one city without including either cafe identity",()=>{
    const basePlace={...scope,name:"Central Campus",kind:"university" as const,
      address:"20 University Ave",sourceUrl:"https://campus.example/about"};
    const one=cityPlaceIdentity(basePlace);
    const two=cityPlaceIdentity({...basePlace,name:"central-campus",
      sourceUrl:"https://city.example/campus"});
    expect(one.identityKey).toBe(two.identityKey);
    expect(JSON.stringify(one)).not.toContain("businessId");
    expect(cityPlaceIdentity({...basePlace,address:"22 University Ave"}).identityKey)
      .not.toBe(one.identityKey);
  });
});

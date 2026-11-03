import {describe, expect, it} from "vitest";
import {
  NEIGHBORHOOD_MAX_OUTPUT_TOKENS, NEIGHBORHOOD_SCOPE_IDS,
  hasResearchableAddress, neighborhoodResearchPrompt, parseNeighborhoodResearch,
  neighborhoodCitedUrls, neighborhoodOutputText, publicPlaceKey,
  summarizeNeighborhoodCoverage, type NeighborhoodAddress,
  type NeighborhoodSourceCoverage,
} from "./neighborhoodResearch";

const address: NeighborhoodAddress = {
  label: "12 Market Street, San Francisco, CA 94103, US",
  city: "San Francisco", region: "CA", countryCode: "US",
};
const date = "2026-11-02T12:00:00.000Z";
const place = {
  name: "Civic Convention Center", type: "convention",
  address: "100 Civic Plaza, San Francisco, CA",
  sourceUrl: "https://convention.city.gov/visit",
  calendarUrl: "https://convention.city.gov/calendar",
  visitorInfoUrl: null,
  visitorApproach: "Visitors use the west entrance",
  visitorApproachSourceUrl: "https://convention.city.gov/visit",
  entrance: "West entrance", entranceSourceUrl: "https://convention.city.gov/visit",
  possibleConnection: "Conference attendees might seek refreshments before sessions",
};
const cited = [place.sourceUrl, place.calendarUrl];
const parse = (places: unknown[], sources: string[] = cited, hasMore = false) =>
  parseNeighborhoodResearch(JSON.stringify({places, hasMore}),
    "campus_and_conventions", sources, date);

describe("LDI C public facts vs café demand hypotheses", () => {
  it("uses the saved address without owner observations or extra providers", () => {
    expect(NEIGHBORHOOD_SCOPE_IDS).toEqual([
      "campus_and_conventions", "workday", "arrivals_and_stays", "evenings_and_weekends",
    ]);
    expect(NEIGHBORHOOD_MAX_OUTPUT_TOKENS).toBe(1200);
    expect(hasResearchableAddress(address)).toBe(true);
    expect(hasResearchableAddress({...address, label: "San Francisco, CA"})).toBe(false);
    expect(hasResearchableAddress({...address, label: ""})).toBe(false);
    const prompt = neighborhoodResearchPrompt(address, "campus_and_conventions");
    expect(prompt).toContain("12 Market Street");
    expect(prompt).toContain("university and convention");
    expect(prompt).toContain("null");
    expect(prompt).not.toContain("owner observation");
    expect(prompt).not.toContain("OpenStreetMap API");
  });

  it("returns citations, same-site calendar, access evidence and explicit unknown fields", () => {
    const result = parse([place]);
    expect(result?.discardedCandidates).toBe(0);
    expect(result?.publicPlaces).toHaveLength(1);
    expect(result?.publicPlaces[0]).toMatchObject({
      name: place.name, type: "convention", address: place.address,
      sourceUrl: place.sourceUrl, calendarUrl: place.calendarUrl,
      visitorApproach: place.visitorApproach, entrance: place.entrance,
      sourceStatus: "cited_public_page", checkedAt: date,
      visitorCount: null, routeDistanceMeters: null, actualCafeDemand: null,
    });
    expect(result?.publicPlaces[0].unknowns).toEqual(expect.arrayContaining([
      "visitor_count", "route_distance", "actual_cafe_demand", "visitor_information",
    ]));
    expect(result?.cafeHypotheses).toEqual([{
      placeKey: publicPlaceKey(place.name, place.address, place.sourceUrl),
      kind: "hypothesis", possibleConnection: place.possibleConnection,
      placeSourceUrl: place.sourceUrl, observedImpact: null, projectedSalesLift: null,
    }]);
  });

  it("rejects unsourced or incorrect-scope places, not classifying them as empty research", () => {
    const impostor = {...place, sourceUrl: "https://madeup.bad-venue.org/passes"};
    const out = parse([impostor, {...place, type: "hospital"}, place]);
    expect(out?.publicPlaces.map(v => v.name)).toEqual(["Civic Convention Center"]);
    expect(out?.discardedCandidates).toBe(2);
    expect(parse([place], [])?.publicPlaces).toEqual([]);
    expect(parse([place], [])?.candidateCount).toBe(1);
  });

  it("does not promote uncited calendars, outside operator pages or unsupported entrances", () => {
    const injected = {...place, calendarUrl: "https://ticket-listings.org/calendar",
      visitorInfoUrl: "https://made-up.example.org/visitor",
      visitorApproach: "Walk 8 minutes", visitorApproachSourceUrl: null,
      entrance: "Private back door", entranceSourceUrl: "https://uncited.org/entrance",
      possibleConnection: "Attendance will increase by 900 customers"};
    const out = parse([injected], [place.sourceUrl, injected.calendarUrl]);
    expect(out?.publicPlaces[0]).toMatchObject({
      calendarUrl: null, visitorInfoUrl: null, visitorApproach: null,
      visitorApproachSourceUrl: null, entrance: null, entranceSourceUrl: null,
    });
    expect(out?.publicPlaces[0].unknowns).toContain("entrance");
    expect(out?.cafeHypotheses).toEqual([]);
  });

  it("deduplicates repeated place identity and separates bounded misses from malformed output", () => {
    expect(parse([place, {...place, sourceUrl: place.sourceUrl}])?.publicPlaces).toHaveLength(1);
    expect(parse([])).toMatchObject({publicPlaces: [], candidateCount: 0});
    expect(parseNeighborhoodResearch("not json", "campus_and_conventions", cited, date)).toBeNull();
    expect(parseNeighborhoodResearch(JSON.stringify({events: []}),
      "campus_and_conventions", cited, date)).toBeNull();
    expect(parse([place], cited, true)?.hasMore).toBe(true);
    expect(parse([...Array(5)].map((_, i) => ({...place, name: "Convention Hall " + i})))
      ?.hasMore).toBe(true);
  });

  it("collects only provider-cited URLs, never arbitrary text or output JSON references", () => {
    const body = {status: "completed", output: [
      {type: "web_search_call", action: {sources: [
        {url: place.sourceUrl}, {url: "http://unsafe.test"}, {url: place.sourceUrl},
      ]}},
      {type: "message", content: [{type: "output_text",
        text: JSON.stringify({places: [place], hasMore: false}),
        annotations: [{type: "url_citation", url: place.calendarUrl},
          {type: "not_a_citation", url: "https://wrong.org"}]}]},
    ]};
    expect(neighborhoodCitedUrls(body)).toEqual(cited);
    expect(neighborhoodOutputText(body)).toContain("Civic Convention Center");
    expect(neighborhoodCitedUrls({output: [{type: "message", content:
      [{type: "output_text", text: "https://uncited.org"}]}]})).toEqual([]);
  });

  it("reports scoped partial/failed coverage without asserting complete city knowledge", () => {
    const base: NeighborhoodSourceCoverage = {
      scope: "workday", categories: ["office", "hospital"],
      checkedAt: date, placesFound: 0, discardedCandidates: 0,
      retryEligible: false, failure: null, outcome: "none_found",
    };
    expect(summarizeNeighborhoodCoverage([base])).toBe("none_found");
    expect(summarizeNeighborhoodCoverage([{...base, outcome: "failed"}])).toBe("failed");
    expect(summarizeNeighborhoodCoverage([base, {...base, outcome: "failed"}])).toBe("partial");
    expect(summarizeNeighborhoodCoverage([base, {...base, outcome: "found"}])).toBe("found");
    expect(summarizeNeighborhoodCoverage([{...base, outcome: "partial"}])).toBe("partial");
  });
});

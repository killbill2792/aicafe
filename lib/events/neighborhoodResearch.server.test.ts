import {afterEach, describe, expect, it, vi} from "vitest";
vi.mock("server-only", () => ({}));
import {createNeighborhoodResearch} from "./neighborhoodResearch.server";

const at = new Date("2026-11-02T14:00:00.000Z");
const market = {label: "12 Market Street, San Francisco, CA 94103, US",
  city: "San Francisco", region: "CA", countryCode: "US"};
const folsom = {...market, label: "800 Folsom Street, San Francisco, CA 94107, US"};
const university = (connection = "Students might buy drinks before class") => ({
  name: "Civic University", type: "university",
  address: "50 University Road, San Francisco, CA",
  sourceUrl: "https://university.edu/about/visit",
  calendarUrl: "https://university.edu/events",
  visitorInfoUrl: null, visitorApproach: null, visitorApproachSourceUrl: null,
  entrance: null, entranceSourceUrl: null, possibleConnection: connection,
});
const makeResponse = (places: unknown[], urls: string[] = [
  "https://university.edu/about/visit", "https://university.edu/events",
], hasMore = false) => ({
  ok: true, status: 200, json: async () => ({
    status: "completed", output: [
      {type: "web_search_call", action: {sources: urls.map(url => ({url}))}},
      {type: "message", content: [{type: "output_text",
        text: JSON.stringify({places, hasMore})}]},
    ],
  }),
});
const incomplete = () => ({
  ok: true, status: 200, json: async () => ({
    status: "incomplete", incomplete_details: {reason: "max_output_tokens"},
    output: [{type: "reasoning"}],
  }),
});
const call = (fetcher: ReturnType<typeof vi.fn>) => createNeighborhoodResearch({
  fetch: fetcher as unknown as typeof fetch, apiKey: "test-api-key",
  model: "gpt-4.1-mini", now: () => at,
});
const bodies = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.map(args => JSON.parse(String((args[1] as RequestInit).body)));

afterEach(() => {vi.restoreAllMocks();});

describe("LDI C OpenAI neighborhood research", () => {
  it("cold-starts with address only and no owner observations, keeping unknown facts null", async () => {
    const fetcher = vi.fn(async () => makeResponse([university()]));
    const result = await call(fetcher)({
      address: market, scopes: ["campus_and_conventions"],
    });
    expect(result).toMatchObject({
      outcome: "found", researchedAddress: market.label, error: null,
      checkedAt: at.toISOString(),
      coverage: [{scope: "campus_and_conventions", outcome: "found",
        placesFound: 1, retryEligible: false, failure: null}],
    });
    expect(result.publicPlaces).toHaveLength(1);
    expect(result.publicPlaces[0]).toMatchObject({
      sourceUrl: "https://university.edu/about/visit",
      calendarUrl: "https://university.edu/events",
      entrance: null, visitorCount: null, routeDistanceMeters: null, actualCafeDemand: null,
    });
    expect(result.cafeHypotheses[0]).toMatchObject({
      kind: "hypothesis", observedImpact: null, projectedSalesLift: null,
    });
    expect(result.unknowns).toEqual(["visitor_count", "route_distance", "actual_cafe_demand"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.openai.com/v1/responses");
    const body = bodies(fetcher)[0];
    expect(body).toMatchObject({model: "gpt-4.1-mini", store: false,
      max_output_tokens: 1200,
      tools: [{type: "web_search", user_location: {
        type: "approximate", city: "San Francisco", region: "CA", country: "US",
      }}]});
    expect(body.input).toContain(market.label);
    expect(body.text.format.strict).toBe(true);
    expect(body.include).toContain("web_search_call.action.sources");
  });

  it("does not conflate two cafés in one city or contaminate their private hypotheses", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(String(init.body)).input as string;
      return makeResponse([university(prompt.includes("12 Market Street") ?
        "Market Street café could see some students" :
        "Folsom Street café might draw different students")]);
    });
    const researcher = call(fetcher);
    const first = await researcher({address: market, scopes: ["campus_and_conventions"]});
    const second = await researcher({address: folsom, scopes: ["campus_and_conventions"]});
    expect(first.publicPlaces[0].placeKey).toBe(second.publicPlaces[0].placeKey);
    expect(first.publicPlaces[0].sourceUrl).toBe(second.publicPlaces[0].sourceUrl);
    expect(first.cafeHypotheses[0].possibleConnection).toContain("Market Street");
    expect(second.cafeHypotheses[0].possibleConnection).toContain("Folsom Street");
    expect(first.researchedAddress).not.toBe(second.researchedAddress);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies(fetcher)[0].input).not.toContain(folsom.label);
    expect(bodies(fetcher)[1].input).not.toContain(market.label);
  });

  it("never makes a provider call for missing or city-only location", async () => {
    const fetcher = vi.fn(async () => makeResponse([university()]));
    const researcher = call(fetcher);
    const missing = await researcher({address: {...market, label: ""}});
    expect(missing).toMatchObject({outcome: "failed", error: "missing_address",
      publicPlaces: [], cafeHypotheses: []});
    expect(missing.coverage).toHaveLength(4);
    expect(missing.coverage[0]).toMatchObject({
      outcome: "failed", retryEligible: false, failure: "missing_address",
    });
    const cityOnly = await researcher({address: {...market, label: "San Francisco, CA"}});
    expect(cityOnly.error).toBe("missing_address");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks a missing API key as failed rather than none_found", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const fetcher = vi.fn();
      const result = await createNeighborhoodResearch({
        fetch: fetcher as unknown as typeof fetch, now: () => at,
      })({address: market, scopes: ["workday"]});
      expect(result).toMatchObject({
        outcome: "failed", error: "not_configured", publicPlaces: [],
        coverage: [{scope: "workday", outcome: "failed",
          retryEligible: true, failure: "not_configured"}],
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it("distinguishes partial source failure, retries only the failing scope, and keeps facts", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(String(init.body)).input as string;
      return prompt.includes("Scope: office and hospital") ?
        incomplete() : makeResponse([university()]);
    });
    const result = await call(fetcher)({address: market,
      scopes: ["campus_and_conventions", "workday"]});
    expect(result.outcome).toBe("partial");
    expect(result.publicPlaces).toHaveLength(1);
    expect(result.coverage).toEqual([
      expect.objectContaining({scope: "campus_and_conventions",
        outcome: "found", retryEligible: false}),
      expect.objectContaining({scope: "workday", outcome: "failed",
        failure: "incomplete", retryEligible: true}),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bodies(fetcher).filter(b => b.input.includes("office and hospital"))).toHaveLength(2);
    expect(bodies(fetcher)[2].text).toBeUndefined();
    expect(bodies(fetcher).every(b => b.max_output_tokens === 1200)).toBe(true);
  });

  it("uses plain JSON fallback after an incomplete structured response", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => incomplete())
      .mockImplementationOnce(async () => makeResponse([university()]));
    const result = await call(fetcher)({address: market,
      scopes: ["campus_and_conventions"]});
    expect(result.outcome).toBe("found");
    expect(result.publicPlaces).toHaveLength(1);
    expect(bodies(fetcher)[0].text?.format?.name).toBe("neighborhood_places");
    expect(bodies(fetcher)[1].text).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("treats a completed empty search differently from an uncited nonempty one", async () => {
    const emptyFetch = vi.fn(async () => makeResponse([]));
    const none = await call(emptyFetch)({address: market, scopes: ["campus_and_conventions"]});
    expect(none).toMatchObject({outcome: "none_found", publicPlaces: [],
      coverage: [{outcome: "none_found", retryEligible: false}]});
    expect(emptyFetch).toHaveBeenCalledTimes(1);
    const dishonestFetch = vi.fn(async () =>
      makeResponse([university()], ["https://unrelated.gov/news"]));
    const bad = await call(dishonestFetch)({address: market, scopes: ["campus_and_conventions"]});
    expect(bad).toMatchObject({outcome: "failed", publicPlaces: [],
      coverage: [{outcome: "failed", failure: "unverified_sources", retryEligible: true}]});
    expect(dishonestFetch).toHaveBeenCalledTimes(2);
  });

  it("marks truncated or mixed verified/invalid source results as partial and refreshable", async () => {
    const fetcher = vi.fn(async () => makeResponse([
      university(), {...university(), name: "Unsourced University",
        sourceUrl: "https://unsourced.edu/"},
    ], undefined, true));
    const result = await call(fetcher)({address: market, scopes: ["campus_and_conventions"]});
    expect(result.publicPlaces).toHaveLength(1);
    expect(result.outcome).toBe("partial");
    expect(result.coverage[0]).toMatchObject({outcome: "partial",
      discardedCandidates: 1, retryEligible: true, failure: null});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("limits an unscoped research run to four groups, two concurrent and no more than eight calls", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      requests.push(b.input as string);
      return {ok: false, status: 503, json: async () => ({})};
    });
    const result = await call(fetcher)({address: market});
    expect(result.outcome).toBe("failed");
    expect(result.coverage.map(s => s.scope)).toEqual([
      "campus_and_conventions", "workday", "arrivals_and_stays", "evenings_and_weekends",
    ]);
    expect(result.coverage.every(s => s.failure === "http_error" && s.retryEligible)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(requests.filter(q => q.includes("Scope:")).toHaveLength(8);
  });
});

import "server-only";
import {DEFAULT_SUPERVISOR_OPENAI_MODEL} from "@/lib/ai/conversations/modelConfig";
import {
  NEIGHBORHOOD_MAX_OUTPUT_TOKENS, NEIGHBORHOOD_SCOPES, NEIGHBORHOOD_SCOPE_IDS,
  NEIGHBORHOOD_UNKNOWNS, hasResearchableAddress, neighborhoodResearchJsonSchema,
  neighborhoodResearchPrompt, parseNeighborhoodResearch, neighborhoodWebSearchCompleted, neighborhoodCitedUrls,
  neighborhoodOutputText, publicPlaceKey, summarizeNeighborhoodCoverage,
  type NeighborhoodAddress, type NeighborhoodScope, type NeighborhoodFailure,
  type NeighborhoodResearchResult, type NeighborhoodSourceCoverage,
  type PublicDemandPlace, type CafeDemandHypothesis,
} from "./neighborhoodResearch";

type Fetcher = typeof fetch;
type ScopeResult = {
  coverage: NeighborhoodSourceCoverage;
  places: PublicDemandPlace[];
  hypotheses: CafeDemandHypothesis[];
};
type Attempt =
  | {ok: true; parsed: NonNullable<ReturnType<typeof parseNeighborhoodResearch>>}
  | {ok: false; failure: NeighborhoodFailure};
const TIMEOUT_MS = 20_000, RETRY_TIMEOUT_MS = 10_000;
const RESEARCH_CONCURRENCY = 2;
const MAX_ATTEMPTS = 2;

/** Run by the existing Events scheduler after authorization/eligibility checks.
 * Never call from a page read. No new scheduler, mapping subscription or persistence.
 * If only failed/partial scopes need refreshing, pass scopes: [their ids]. */
export function createNeighborhoodResearch(deps: {
  fetch?: Fetcher;
  apiKey?: string;
  model?: string;
  now?: () => Date;
} = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  return async (input: {
    address: NeighborhoodAddress;
    /** Omit for all four bounded groups; subset for scoped refresh. */
    scopes?: readonly NeighborhoodScope[];
  }): Promise<NeighborhoodResearchResult> => {
    const checkedAt = now().toISOString();
    const address = input.address;
    const scopes = input.scopes === undefined ? NEIGHBORHOOD_SCOPE_IDS :
      NEIGHBORHOOD_SCOPE_IDS.filter(scope => input.scopes?.includes(scope));
    const empty = (error: "missing_address" | "not_configured",
      failure: NeighborhoodFailure): NeighborhoodResearchResult => ({
      outcome: "failed", checkedAt, researchedAddress: address?.label ?? "",
      publicPlaces: [], cafeHypotheses: [], unknowns: NEIGHBORHOOD_UNKNOWNS, error,
      coverage: scopes.map(scope => ({
        scope, categories: NEIGHBORHOOD_SCOPES[scope], outcome: "failed",
        checkedAt, placesFound: 0, discardedCandidates: 0,
        retryEligible: error !== "missing_address", failure,
      })),
    });
    if (!address || !hasResearchableAddress(address)) return empty("missing_address", "missing_address");
    const key = deps.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) return empty("not_configured", "not_configured");
    const model = deps.model ?? (process.env.EVENTS_SEARCH_OPENAI_MODEL?.trim() ||
      DEFAULT_SUPERVISOR_OPENAI_MODEL);

    const search = async (scope: NeighborhoodScope, attemptNumber: number): Promise<Attempt> => {
      try {
        const strict = attemptNumber === 1;
        const userLocation = address.city || address.region || address.countryCode ?
          {type: "approximate" as const,
            ...(address.city ? {city: address.city} : {}),
            ...(address.region ? {region: address.region} : {}),
            ...(address.countryCode ? {country: address.countryCode} : {})} : null;
        const response = await doFetch("https://api.openai.com/v1/responses", {
          method: "POST",
          signal: AbortSignal.timeout(strict ? TIMEOUT_MS : RETRY_TIMEOUT_MS),
          headers: {"Content-Type": "application/json", Authorization: "Bearer " + key},
          body: JSON.stringify({
            model, store: false, max_output_tokens: NEIGHBORHOOD_MAX_OUTPUT_TOKENS,
            tools: [{type: "web_search", ...(userLocation ? {user_location: userLocation} : {})}],
            include: ["web_search_call.action.sources"],
            input: neighborhoodResearchPrompt(address, scope),
            ...(strict ? {text: {format: {type: "json_schema", name: "neighborhood_places",
              strict: true, schema: neighborhoodResearchJsonSchema}}} : {}),
          }),
        });
        if (!response.ok) return {ok: false, failure: "http_error"};
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") return {ok: false, failure: "invalid_response"};
        const status = (body as {status?: unknown}).status;
        if (status === "incomplete") return {ok: false, failure: "incomplete"};
        if (status !== "completed") return {ok: false, failure: "invalid_response"};
        if (!neighborhoodWebSearchCompleted(body)) return {ok: false, failure: "search_not_run"};
        const output = neighborhoodOutputText(body);
        if (!output) return {ok: false, failure: "invalid_response"};
        const parsed = parseNeighborhoodResearch(output, scope,
          neighborhoodCitedUrls(body), checkedAt);
        if (!parsed) return {ok: false, failure: "invalid_response"};
        if (parsed.candidateCount > 0 && parsed.publicPlaces.length === 0)
          return {ok: false, failure: "unverified_sources"};
        return {ok: true, parsed};
      } catch (e) {
        return {ok: false, failure: e instanceof Error &&
          (e.name === "AbortError" || e.name === "TimeoutError") ?
          "timeout" : "invalid_response"};
      }
    };

    const runScope = async (scope: NeighborhoodScope): Promise<ScopeResult> => {
      let outcome: Attempt = {ok: false, failure: "invalid_response"};
      for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        outcome = await search(scope, i);
        // Keep partial credible evidence; retry failures only, never overwrite it.
        if (outcome.ok) break;
      }
      if (!outcome.ok) {
        console.warn("neighborhood_research_scope_failed", {scope, category: outcome.failure});
        return {places: [], hypotheses: [], coverage: {
          scope, categories: NEIGHBORHOOD_SCOPES[scope], outcome: "failed", checkedAt,
          placesFound: 0, discardedCandidates: 0, retryEligible: true, failure: outcome.failure,
        }};
      }
      const parsed = outcome.parsed;
      const partial = parsed.discardedCandidates > 0 || parsed.hasMore;
      const status = partial ? "partial" :
        parsed.publicPlaces.length ? "found" : "none_found";
      return {places: parsed.publicPlaces, hypotheses: parsed.cafeHypotheses, coverage: {
        scope, categories: NEIGHBORHOOD_SCOPES[scope], outcome: status, checkedAt,
        placesFound: parsed.publicPlaces.length,
        discardedCandidates: parsed.discardedCandidates,
        retryEligible: partial, failure: null,
      }};
    };

    // Deterministic, capped provider work: four scopes, two concurrent, <=8 calls.
    const results: ScopeResult[] = [];
    for (let start = 0; start < scopes.length; start += RESEARCH_CONCURRENCY) {
      const batch = await Promise.all(scopes.slice(start, start + RESEARCH_CONCURRENCY)
        .map(runScope));
      results.push(...batch);
    }
    const coverage = results.map(r => r.coverage);
    const publicPlaces: PublicDemandPlace[] = [];
    const cafeHypotheses: CafeDemandHypothesis[] = [];
    const seenPlaces = new Set<string>(), seenHypotheses = new Set<string>();
    for (const r of results) {
      for (const p of r.places) {
        // Facts are reusable across cafés; this key cannot include a café ID.
        const key = publicPlaceKey(p.name, p.address, p.sourceUrl);
        if (!seenPlaces.has(key)) {seenPlaces.add(key); publicPlaces.push(p);}
      }
      for (const h of r.hypotheses) {
        const key = h.placeKey + "|" + h.possibleConnection;
        if (!seenHypotheses.has(key)) {seenHypotheses.add(key); cafeHypotheses.push(h);}
      }
    }
    return {outcome: summarizeNeighborhoodCoverage(coverage), checkedAt,
      researchedAddress: address.label, publicPlaces, cafeHypotheses,
      unknowns: NEIGHBORHOOD_UNKNOWNS, coverage, error: null};
  };
}

/** Adapter exported for PR E. It has no side effects until E invokes it from the cron. */
export const researchNeighborhood = createNeighborhoodResearch();

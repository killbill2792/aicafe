import { PassThrough } from "node:stream";
import { createElement, Suspense } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DeferredChatStart, { type HomeStartPayload } from "./DeferredChatStart";

// Exercise the real promise/Suspense boundary, without unrelated Next navigation or events.
vi.mock("./ChatStart", () => ({
  default: ({ data, copy }: { data: HomeStartPayload["data"]; copy: HomeStartPayload["copy"] }) =>
    createElement("section", { "data-testid": "canonical-summary" },
      createElement("span", {}, data.period),
      createElement("span", {}, data.sales),
      createElement("span", {}, data.costs),
      createElement("span", {}, data.kept),
      createElement("span", {}, copy.summary),
      createElement("span", {}, data.salesCaption ?? ""),
      createElement("span", {}, data.partial ? copy.partial : ""),
    ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function renderChatWithBoard(promise: Promise<HomeStartPayload | null>, pendingLabel: string) {
  const output = new PassThrough();
  let html = "";
  output.on("data", chunk => { html += chunk.toString(); });
  const shell = deferred<void>();
  const complete = deferred<void>();
  output.on("end", () => complete.resolve());
  const content = createElement("main", {},
    createElement("label", { htmlFor: "chat-input" }, "Ask Supervisor"),
    createElement("textarea", { id: "chat-input", defaultValue: "Draft stays" }),
    createElement(Suspense, { fallback: createElement("p", { role: "status" }, pendingLabel) },
      createElement(DeferredChatStart, {
        promise,
        suggestions: [], failureText: "Summary not verified",
        hasMessages: false, expanded: false, onToggle: () => {},
        onSuggestion: () => {}, suggestionsDisabled: false,
      }),
    ),
  );
  const renderer = renderToPipeableStream(content, {
    onShellReady() { renderer.pipe(output); shell.resolve(); },
    onError(error) { shell.resolve(); complete.resolve(); throw error; },
  });
  return { shell: shell.promise, complete: complete.promise, html: () => html, abort: () => renderer.abort() };
}

const periodSummary: HomeStartPayload = {
  data: {
    period: "week", sales: "€152.00", costs: "—", kept: "—",
    attention: [], partial: true, estimated: false, incomplete: true,
    shareCaption: null, comparisonCaption: null,
    salesCaption: "Provisional reading",
  },
  copy: {
    keyNumbers: "Numbers", sales: "Sales", knownCosts: "Costs", youKeep: "Kept",
    partial: "Partial", estimate: "Estimate", incomplete: "Incomplete",
    details: "Details", seeAll: "See all", allGood: "All good",
    summary: "Week summary", roles: { alex: "Sales", leo: "Menu", maya: "Costs", olivia: "Staff" },
    experimentPrompt: "Experiment", suggestionsLabel: "Suggestions", handledLabel: "Handled",
    boardRunning: "Running", boardReports: "Reports",
  },
};

describe("Supervisor Home progressive summary", () => {
  it("keeps the composer usable while an authentic summary is still pending", async () => {
    const reading = deferred<HomeStartPayload | null>();
    const rendered = renderChatWithBoard(reading.promise, "Checking café facts…");
    await rendered.shell;
    const initial = rendered.html();
    expect(initial).toContain("Ask Supervisor");
    expect(initial).toContain("Draft stays");
    expect(initial).toContain("Checking café facts");
    expect(initial).not.toContain("€152.00");
    expect(initial).not.toContain("canonical-summary");
    reading.resolve(periodSummary);
    await rendered.complete;
    const final = rendered.html();
    expect(final).toContain("€152.00");
    expect(final).toContain("Provisional reading");
    expect(final).toContain("Partial");
    expect(final).toContain("week");
    expect(final).toContain("Draft stays");
  });

  it("never substitutes zero or an old period when the canonical read fails", async () => {
    const reading = deferred<HomeStartPayload | null>();
    const rendered = renderChatWithBoard(reading.promise, "Comprobando datos…");
    await rendered.shell;
    reading.resolve(null);
    await rendered.complete;
    expect(rendered.html()).toContain("Summary not verified");
    expect(rendered.html()).toContain("Draft stays");
    expect(rendered.html()).not.toContain("canonical-summary");
    expect(rendered.html()).not.toContain("€152.00");
  });

  it("preserves selected-period and partial-data labels exactly as delivered", async () => {
    const reading = deferred<HomeStartPayload | null>();
    const rendered = renderChatWithBoard(reading.promise, "جارٍ التحقق…");
    await rendered.shell;
    reading.resolve({ ...periodSummary, data: { ...periodSummary.data, period: "today", sales: "—", salesCaption: null } });
    await rendered.complete;
    expect(rendered.html()).toContain("today");
    expect(rendered.html()).toContain("Partial");
    expect(rendered.html()).not.toContain("€152.00");
    expect(rendered.html()).not.toContain("Provisional reading");
  });
});

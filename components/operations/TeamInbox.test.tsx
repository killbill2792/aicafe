import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let query = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, href, ...props }: { children: ReactNode; href: unknown }) =>
  createElement("a", { href: JSON.stringify(href), ...props }, children) }));
vi.mock("@/components/operations/agentVisuals", () => ({
  AgentAvatar: () => createElement("span", null, "avatar"),
  agentVisuals: new Proxy({}, { get: () => ({ icon: () => null, accent: "", softSurface: "", strongSurface: "", glow: "", border: "" }) }),
}));
import TeamInbox, { type TeamInboxCard, type TeamInboxCopy } from "./TeamInbox";
import type { TeamMemberState } from "@/lib/viewmodels/operationsTeam";

const card = (id: string, agentId: TeamInboxCard["agentId"], status: TeamInboxCard["status"]): TeamInboxCard =>
  ({ id, agentId, status, node: createElement("article", { "data-card": id }, id) });
const cards = [card("rent", "leo", "needs_you"), card("unmatched", "maya", "needs_you"),
  card("latte", "alex", "needs_you"), card("old-price", "alex", "handled"), card("supplies", "maya", "watching")];
const members: TeamMemberState[] = (["alex", "olivia", "maya", "leo"] as const)
  .map((agentId) => ({ agentId, attentionCount: 0, statusKey: "attention" as const }));
const byAgent = <T,>(value: T) => ({ alex: value, olivia: value, maya: value, leo: value });
const copy: TeamInboxCopy = {
  eyebrow: "Café operations", title: "Team inbox", intro: "Everyone", focusedOn: { alex: "Viewing Alex", olivia: "Viewing Olivia", maya: "Viewing Maya", leo: "Viewing Leo" },
  team: { title: "Team", aiLabel: "AI", brandLabel: "Brand", names: { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" },
    roles: byAgent("Role"), status: byAgent("status"), need: byAgent(null) },
  statusLabels: { needs_you: "Needs you", handled: "Handled", watching: "Watching" }, navLabel: "Inbox",
  empty: { needs_you: "Nothing needs you", handled: "Nothing handled", watching: "Nothing watched" },
  rules: null, transportUnavailable: "Transport note",
};
const props = { members, cards, copy, staffRulesLink: null, footer: null };
const render = (at: string) => { query = at; return renderToStaticMarkup(createElement(TeamInbox, props)); };
const shown = (markup: string) => [...markup.matchAll(/data-card="([^"]+)"/g)].map((match) => match[1]);

/** Walk the element tree TeamInbox returns, to call the real tap handlers without a browser. */
function findAll(node: ReactNode, test: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, test));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [...(test(node) ? [node] : []), ...findAll(node.props.children as ReactNode, test)];
}
function tap(at: string, test: (element: ReactElement<Record<string, unknown>>) => boolean, arg: unknown) {
  query = at;
  const pushState = vi.fn();
  vi.stubGlobal("window", { location: { pathname: "/en/operations" }, history: { pushState } });
  const [target] = findAll(TeamInbox(props), test);
  const handler = (target.props.onSelect ?? target.props.onClick) as (value: unknown) => void;
  handler(arg);
  return pushState.mock.calls.map((call) => call[2]);
}
const click = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, preventDefault: vi.fn() };

afterEach(() => vi.unstubAllGlobals());

describe("Team inbox switches teammates and tabs in the browser", () => {
  it("shows the whole team's Needs you with each tab's count", () => {
    const markup = render("period=week");
    expect(shown(markup)).toEqual(["rent", "unmatched", "latte"]);
    expect(markup).toContain("Needs you 3");
    expect(markup).toContain("Handled 1");
    expect(markup).toContain("Watching 1");
  });

  it("shows only the selected teammate's cards and counts", () => {
    const markup = render("period=week&agent=maya");
    expect(shown(markup)).toEqual(["unmatched"]);
    expect(markup).toContain("Viewing Maya");
    expect(markup).toContain("Needs you 1");
    expect(markup).toContain("Handled 0");
    expect(shown(render("agent=alex&status=handled"))).toEqual(["old-price"]);
    expect(render("agent=olivia")).toContain("Nothing needs you");
  });

  it("tapping a teammate updates the URL without a reload and keeps the period", () => {
    const urls = tap("period=week&agent=maya", (element) => typeof element.props.onSelect === "function", "leo");
    expect(urls).toEqual(["/en/operations?period=week&agent=leo"]);
    expect(shown(render("period=week&agent=leo"))).toEqual(["rent"]);
  });

  it("tapping a tab updates the URL without a reload and keeps teammate and period", () => {
    const urls = tap("period=month&agent=alex", (element) => element.type === "a" && element.props["aria-current"] === undefined &&
      String(element.props.href).includes("status=handled"), click);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(urls).toEqual(["/en/operations?period=month&agent=alex&status=handled"]);
  });

  it("keeps the period on the teammate links for a normal page load", () => {
    expect(render("period=week")).toContain(`&quot;period&quot;:&quot;week&quot;`);
  });
});

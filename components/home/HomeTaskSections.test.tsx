import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as React.ReactNode),
}));

import HomeTaskSections from "./HomeTaskSections";

describe("Home Needs your attention", () => {
  it("renders a clear empty state and does not offer a fix button", () => {
    const html = renderToStaticMarkup(createElement(HomeTaskSections, {
      title: "Needs your attention", empty: "Nothing needs you right now", seeAll: "See all", items: [],
    }));
    expect(html).toContain("Nothing needs you right now");
    expect(html).not.toContain("See all");
    expect(html).not.toContain('href="/operations"');
  });

  it("shows at most five one-action rows and sends overflow to Operations", () => {
    const items = Array.from({ length: 7 }, (_, index) => ({
      id: String(index), title: "Issue " + index, actionLabel: "Fix",
      href: "/more/bills?category=rent", impactCents: (7 - index) * 100,
    }));
    const html = renderToStaticMarkup(createElement(HomeTaskSections, {
      title: "Needs your attention", empty: "Nothing needs you right now", seeAll: "See all", items,
    }));
    expect((html.match(/>Fix<\/a>/g) ?? []).length).toBe(5);
    expect(html).toContain('href="/operations"');
    expect(html).not.toContain("Issue 6");
  });
});

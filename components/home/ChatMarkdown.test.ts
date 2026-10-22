import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown";

describe("chat message rendering", () => {
  it("renders bold, ordered/unordered lists and inline code without raw markers", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "**Profit**\n\n- Costs\n- Sales\n\n1. First\n2. Second\n\nUse `menu`",
      label: "Unverified",
    }));
    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<code");
    expect(html).not.toContain("**Profit**");
  });
  it("escapes model HTML rather than injecting it", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "<script>alert('bad')</script>", label: "Unverified",
    }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("preserves original source offsets and labels unverified figures", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "Total **$123**", unverified: [{ start: 8, end: 14 }], label: "Unverified",
    }));
    expect(html).toContain("Unverified");
    expect(html).toContain("$123");
  });
});

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
  it("preserves explicit ordered steps across blank lines and non-one starts", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "3. Check sales\n\n4. Check costs\n\n5. Review **profit**",
      label: "Unverified",
    }));
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain('start="3"');
    expect(html).toContain('value="3"');
    expect(html).toContain('value="4"');
    expect(html).toContain('value="5"');
    expect(html).toContain("<strong");
  });
  it("keeps markdown lists and formatting when a number is unverified", () => {
    const source = "1. **Revenue $123**\n\n2. Check costs";
    const start = source.indexOf("$123");
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: source, unverified: [{ start, end: start + 4 }], label: "Unverified",
    }));
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain("<strong");
    expect(html).toContain('value="2"');
    expect(html).toContain("Unverified");
    expect(html).not.toContain("**");
  });
  it("supports CRLF offsets, literal HTML and multiple independent labels", () => {
    const source = "1. **$10**\r\n2. _€20_";
    const startA = source.indexOf("$10"), startB = source.indexOf("€20");
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: source, unverified: [
        { start: startA, end: startA + 3 }, { start: startB, end: startB + 3 },
      ], label: "Unverified",
    }));
    expect(html.match(/role="note"/g)).toHaveLength(2);
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html.match(/<ol/g)).toHaveLength(1);
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

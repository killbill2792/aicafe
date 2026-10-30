import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import MoneyLoading from "@/app/[locale]/money/loading";
import MenuLoading from "@/app/[locale]/menu/loading";
import RootLoading from "@/app/[locale]/loading";
import PageShell from "./PageShell";

describe("navigation usability markers",()=>{
  it.each([
    ["root",RootLoading],["money",MoneyLoading],["menu",MenuLoading],
  ])("%s skeleton signals loading instead of a ready screen",(_name,Screen)=>{
    const markup=renderToStaticMarkup(<Screen/>);
    expect(markup).toContain('data-perf-loading="true"');
    expect(markup).not.toContain("data-perf-ready");
    expect(markup).toContain("animate-pulse");
  });
  it("real content is ready, not a loading shell",()=>{
    const markup=renderToStaticMarkup(<PageShell>Real content</PageShell>);
    expect(markup).toContain('data-perf-ready="true"');
    expect(markup).not.toContain("data-perf-loading");
    expect(markup).toContain("Real content");
  });
});

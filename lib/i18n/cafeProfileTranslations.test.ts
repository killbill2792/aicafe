import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

/** Route call-key contract: catches missing messages even when a screenshot
 * test never reaches a rarely visited profile field. English is authoritative;
 * do not require edits to Spanish/Arabic while new copy is being reviewed. */
describe("English Café Profile message contract",()=>{
  it("covers each static t(key) reference from the owner profile route",()=>{
    const source=readFileSync("app/[locale]/more/cafe-profile/page.tsx","utf8");
    const messages=JSON.parse(readFileSync("messages/en.json","utf8")) as {
      CafeProfile:Record<string,unknown>;
    };
    const keys=[...source.matchAll(/\bt\("([^"]+)"/g)].map(match=>match[1]);
    expect(keys.length).toBeGreaterThan(35);
    for(const key of keys)expect(messages.CafeProfile, key).toHaveProperty(key);
  });
});

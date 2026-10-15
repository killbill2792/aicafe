import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SOURCE_SURFACES, LEGACY_MODEL_TOOL_SURFACES } from "./p1SourceManifest";
import { values } from "./p1Catalog";

describe("P1 independent public surface inventory",()=>{
  it("flags new/renamed/removed business exports until explicitly classified",()=>{
    for(const [path,expected] of Object.entries(SOURCE_SURFACES)){
      const source=readFileSync(new URL("../../"+path,import.meta.url),"utf8");
      const names=[...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class)\s+([A-Za-z]\w*)/g)]
        .map(m=>m[1]).sort();
      expect(names,path).toEqual(Object.keys(expected).sort());
      for(const [name,mapping] of Object.entries(expected)){
        if("capabilities" in mapping){
          expect(mapping.capabilities.length,path+":"+name).toBeGreaterThan(0);
          for(const id of mapping.capabilities) expect(id in values,path+":"+name+":"+id).toBe(true);
        } else {
          expect(mapping.restricted.length,path+":"+name).toBeGreaterThan(12);
        }
      }
    }
  });
  it("covers every legacy model-facing tool without routing through the P1 registry",()=>{
    const source=readFileSync(new URL("../ai/conversations/toolRegistry.server.ts",import.meta.url),"utf8");
    const declarations=source.split("const schemas = {")[1].split("} as const;")[0];
    const names=[...declarations.matchAll(/^\s{2}(\w+):/gm)].map(m=>m[1]).sort();
    expect(names).toEqual(Object.keys(LEGACY_MODEL_TOOL_SURFACES).sort());
    for(const definition of Object.values(LEGACY_MODEL_TOOL_SURFACES)){
      if("capabilities" in definition)
        for(const id of definition.capabilities)expect(values).toHaveProperty(id);
      else expect(definition.restricted.length).toBeGreaterThan(5);
    }
  });
});

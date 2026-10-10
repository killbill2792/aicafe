import { describe, expect, it } from "vitest";
import { nextDictationStage, type DictationStage } from "./dictationState";

describe("Supervisor speech state machine", () => {
  it("supports idle → listening → recognizing → ready → idle", () => {
    let state: DictationStage = "idle";
    state = nextDictationStage(state, { type: "start" });
    expect(state).toBe("listening");
    state = nextDictationStage(state, { type: "stop" });
    expect(state).toBe("recognizing");
    state = nextDictationStage(state, { type: "result" });
    expect(state).toBe("ready");
    state = nextDictationStage(state, { type: "end", hadResult: true, hadError: false });
    expect(state).toBe("ready");
    expect(nextDictationStage(state, { type: "reset" })).toBe("idle");
  });

  it("does not remain listening on silence, permission error or browser end", () => {
    const state = nextDictationStage("listening", { type: "end", hadResult: false, hadError: false });
    expect(state).toBe("error");
    expect(nextDictationStage("listening", { type: "error" })).toBe("error");
    expect(nextDictationStage("error", { type: "end", hadResult: false, hadError: true })).toBe("error");
    expect(nextDictationStage("error", { type: "start" })).toBe("listening");
  });

  it("has no sending transition: owner must review and explicitly submit their text", () => {
    const stages: DictationStage[] = ["idle", "listening", "recognizing", "ready", "error"];
    for (const stage of stages) {
      expect(["idle", "listening", "recognizing", "ready", "error"])
        .toContain(nextDictationStage(stage, { type: "result" }));
    }
    expect(nextDictationStage("ready", { type: "end", hadResult: true, hadError: false })).toBe("ready");
  });
});

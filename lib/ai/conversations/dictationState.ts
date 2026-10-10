/** Pure, testable dictation lifecycle. Browser events must never submit a message. */
export type DictationStage = "idle" | "listening" | "recognizing" | "ready" | "error";
export type DictationEvent =
  | { type: "start" } | { type: "stop" } | { type: "result" }
  | { type: "end"; hadResult: boolean; hadError: boolean }
  | { type: "error" } | { type: "reset" };

export function nextDictationStage(stage: DictationStage, event: DictationEvent): DictationStage {
  switch (event.type) {
    case "start": return "listening";
    case "stop": return stage === "listening" ? "recognizing" : stage;
    case "result": return "ready";
    case "error": return "error";
    case "end":
      if (stage === "error" || event.hadError) return "error";
      return event.hadResult ? "ready" : "error";
    case "reset": return "idle";
  }
}

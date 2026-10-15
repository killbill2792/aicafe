import { describe, expect, it } from "vitest";
import { stableCreateRequestKey, type PendingCreate } from "./idempotencyClient";

describe("Olivia per-record idempotent create retry", () => {
  it("keeps identical payload keyed to one receipt across retries", () => {
    const state: {current:PendingCreate} = {current:null};
    const key = stableCreateRequestKey(state, {code:"opener",active:true});
    expect(stableCreateRequestKey(state,{code:"opener",active:true})).toBe(key);
    expect(state.current?.key).toBe(key);
  });
  it("requires a new request identity after the payload changes", () => {
    const state: {current:PendingCreate} = {current:null};
    const first=stableCreateRequestKey(state,{day_of_week:3,start_local:"07:00"});
    const second=stableCreateRequestKey(state,{day_of_week:3,start_local:"08:00"});
    expect(second).not.toBe(first);
  });
});

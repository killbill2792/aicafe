import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import SupervisorRoutineInlineCard from "./SupervisorRoutineInlineCard";

const receipt={type:"routine_card" as const,
  routineId:"11111111-1111-4111-8111-111111111111",
  title:"Daily inventory check",cadence:"daily" as const,weekdays:[],
  localTime:"08:00",timezone:"America/Los_Angeles",status:"active" as const,revision:1};
const view=(block:unknown)=>renderToStaticMarkup(createElement(SupervisorRoutineInlineCard,{block,onEdit:()=>{}}));

describe("verified minimal routine acknowledgements",()=>{
  it("shows one brief saved confirmation with details hidden under a control",()=>{
    const html=view(receipt);
    expect(html).toContain("Routine created");
    expect(html).toContain('data-routine-card="11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("<details");
    expect(html).toContain("Daily inventory check");
    expect(html).not.toContain("rounded-xl border border-line bg-surface px-3 py-2");
  });
  it("reflects updated, paused and revoked persisted statuses",()=>{
    expect(view({...receipt,revision:2})).toContain("Routine updated");
    expect(view({...receipt,status:"paused",revision:2})).toContain("Routine paused");
    const deleted=view({...receipt,status:"revoked",revision:3});
    expect(deleted).toContain("Routine deleted");
    expect(deleted).not.toContain("<details");
  });
  it("never renders a saved state from an invalid routine receipt",()=>{
    expect(view({...receipt,routineId:"untrusted"})).toBe("");
  });
});

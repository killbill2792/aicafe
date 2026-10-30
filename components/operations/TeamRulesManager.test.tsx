import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

describe("integrated AI Team rules UX",()=>{
  it("uses the selected Team card as the only specialist selector",()=>{
    const manager=readFileSync("components/operations/TeamRulesManager.tsx","utf8");
    // The Team card, rules and tabs render in TeamInbox so teammates switch without a reload.
    const page=readFileSync("components/operations/TeamInbox.tsx","utf8");
    expect(manager).not.toContain("<select");
    expect(manager).not.toContain("POLICY_AGENTS");
    expect(manager).toContain("selectedAgent:RuleAgent");
    expect(manager).toContain("agentId:selectedAgent");
    expect(page).toContain('<TeamRulesManager selectedAgent={agent ?? "supervisor"}');
    expect(page).not.toContain('<details id="team-rules"');
    expect(page.indexOf("<AITeamCard")).toBeLessThan(page.indexOf('id="team-rules"'));
    expect(page.indexOf('id="team-rules"')).toBeLessThan(page.indexOf("<nav"));
  });
  it("keeps edit-as-draft immutable and hides audit history behind progressive disclosure",()=>{
    const manager=readFileSync("components/operations/TeamRulesManager.tsx","utf8");
    expect(manager).toContain("setEditingFrom(rule)");
    expect(manager).toContain("copy.editNotice");
    expect(manager).toContain('method: "POST"');
    expect(manager).toContain('body: JSON.stringify({ agentId:selectedAgent, instruction: instruction.trim() })');
    expect(manager).toContain("<details");
    expect(manager).toContain("copy.recentChanges");
  });
  it("redirects old standalone rules bookmarks into the integrated Team page",()=>{
    const route=readFileSync("app/[locale]/operations/rules/page.tsx","utf8");
    expect(route).toContain('href:"/staff/rules"');
    expect(route).not.toContain("TeamRulesManager");
  });
});

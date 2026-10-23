/** Ship-dark switches for the chat experience. All default OFF: with no env
 * set, the chat behaves exactly as before this change. Read on the server only;
 * the client learns a feature is on from the server's own events/responses.
 *
 *   CHAT_STYLE_V2=1  answer-first style rules in the model instructions
 *   CHAT_JOBS=1      background turns that survive reloads + mid-run follow-ups
 *   CHAT_MEMORY=1    approved café facts loaded into context + "remember" tool
 */
export type ChatExperienceFlags = { style: boolean; jobs: boolean; memory: boolean };
type Env = Record<string, string | undefined>;
const on = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true";

export function chatExperienceFlags(env: Env = process.env): ChatExperienceFlags {
  return { style: on(env.CHAT_STYLE_V2), jobs: on(env.CHAT_JOBS), memory: on(env.CHAT_MEMORY) };
}

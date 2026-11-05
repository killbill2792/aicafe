## 1. What we are building
An **AI operator for independent café owners**: one AI assistant (the Supervisor chat) that runs the café
for the owner and reports back. It answers, plans, drafts, monitors and follows up, the way a good
manager or CEO would. The owner decides; the AI does the work.

- **Web app first.** It must work well in desktop and phone browsers. A native phone app comes later.
- **Chat is the product.** The end goal: the Supervisor chat is the only screen an owner needs.
  Existing screens stay until the chat covers them, but every new capability is built for the chat
  first. A screen is optional, never required.
- **Owners:** 30–70 years old, EN/ES/AR (RTL), many not tech-comfortable. Plain words, no jargon.
- **Answer style:** short and direct, like a good chat assistant (think Grok). Answer first, then the
  key number, then one next step. Working and sources go behind "How I got this".

### The operator loop (every capability follows it)
Understand → Answer → Propose → Owner approves → Act → Monitor → Report back.

Examples of the target behavior:
- **Scheduling:** "Make next week's schedule." The AI drafts it from availability, rules and expected
  sales, shows labor cost, the owner approves, and the AI prepares each staff message with a
  WhatsApp/SMS button that the owner taps to send.
- **Price experiment:** "Should I raise the latte 10¢?" The AI shows the current price, margin and
  expected effect (calculated by code). "Run it for 10 days." Owner approves, changes the price in the
  POS and confirms. The AI monitors daily, sends an update if something notable happens, and posts a
  final report with a recommendation.
- **Proactive:** the AI notices a problem (costs up, coverage gap, sales drop, missing data) and tells
  the owner without being asked, with a suggested action.

## 2. What the AI may do (autonomy)
| Level | What | Rule |
|---|---|---|
| Alone | Read data, answer, analyze, compare, simulate what-ifs, draft plans/schedules/messages | Always allowed. Drafts are inert until approved. |
| Owner approves each time | Anything with an effect: publish a schedule, start or stop an experiment, record purchases, staff changes, rule changes, anything that moves money | An approval card (preview + Approve/Decline). Only the owner's click commits. |
| "Always allow" (planned, not built) | Owner may later pre-approve one action type | Must be set by the owner per action type, revocable, logged. Never for money-moving actions unless the owner explicitly turns it on. Do not build until a task asks for it. |
| Not now | Change POS prices or menus; send messages directly to staff or suppliers; move money | POS changes are done by the owner, then confirmed in chat. Messages are copy-ready text plus a WhatsApp/SMS button the owner taps. Direct sending waits until a verified business WhatsApp/SMS sender exists. |

Never claim an action happened unless its tool succeeded. A drafted proposal is not a completed action.

## 3. One system, no duplicates (the most important engineering rule)
The chat and every screen must show the same thing from the same code. Two parallel paths is a bug.
- **One reader per fact** in `lib/data/` (RLS-scoped), used by both screens and chat tools.
- **One calculation per metric** in `lib/metrics/core/` (profit, labor, fees, break-even, margins).
  `lib/calc/` holds other pure helpers; money metrics there are legacy and must be redirected to core,
  never copied.
- **One attention list** (`lib/attention/`), one **experiment/monitoring system**, one **inbox**
  (`operating_tasks`).
- If you find two implementations of the same thing, do not add a third and do not pick one silently.
  Note it in the PR and ask which one survives.
- A screen and the chat showing the same number must have an exact-equality test.

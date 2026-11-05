## 7. Numbers and money (non-negotiable)
1. Money is integer cents. Never floats. Format only at display.
2. **The model never does arithmetic in its head.** Screen numbers come from `lib/metrics/core/`.
   All other math goes through the calculator tool, with steps shown.
   - *Screen numbers* (profit, labor cost, card fees, break-even, item cost) have one definition in
     `lib/metrics/core/`. When an answer needs one, the model uses the tool that returns it, so the chat
     always matches the screens. This list grows only when a new number is added to a screen.
   - *Everything else:* the model reads the data with `describe_data`/`query_data` and the other read
     tools, decides the method, and does every sum through the one `calculate` tool: + − × ÷, sum and
     percent only. No money definitions and no code execution. Every input comes from a tool result
     or a saved owner fact. The answer shows inputs, formula and steps, labeled calculation or estimate.
     A test ensures the calculator is never used to rebuild a screen number.
   - No new tool or scenario per question type. A new tool is added only for new data or a new action.
   *Why:* models make arithmetic mistakes, and owners act on these numbers.
3. Every number the model states must come from a tool result or the owner's own words.
   `lib/ai/agent/checkNumbers.ts` compares them after the reply. A mismatch is logged and the figure gets
   an "unverified" chip. Never delete the sentence and never call a second LLM to review.
4. Estimated vs actual is always labeled. Unknown is never shown as zero.
5. **Always the café's own currency** (`businesses.currency`). Never hard-code `"USD"` anywhere:
   formatting, schemas, checks or defaults. If the currency is missing, show the amount with a
   "currency not set" note.
6. Partial data never blocks an answer. Give the best labeled answer and say exactly what is missing
   (e.g. "based on 5 days of sales").
7. Use `docs/05-calculations.md` fixtures as tests. If a test disagrees with the doc, stop and ask.

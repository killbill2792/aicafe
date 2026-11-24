## 7. Numbers and money (non-negotiable)
1. Money is integer cents. Never floats. Format only at display.
2. **Verified information and correct arithmetic are the authority, not a named tool.** Official
   screen metrics retain their shared definitions in `lib/metrics/core/`: same sources, period,
   currency, inputs and assumptions must produce the same result. Make the shared calculation
   basis and results accessible through common research, not dedicated model-facing reporting tools.
   - The model chooses analytical SQL for relational calculations and the one general calculator
     for further exact arithmetic. No mental arithmetic, mandatory call order or redundant calculation.
   - Independent calculations and alternatives may use verified SQL receipts, authorized saved facts,
     owner-supplied numbers and explicitly hypothetical assumptions. Never present an assumption as
     an actual observation or imply an independently computed metric is official screen parity.
     Show relevant inputs, formula, period, units, source and uncertainty. Arithmetic correctness
     does not establish business correctness.
   - No new tool per question type. Preserve unique operational capabilities and shared calculation
     engines; consolidate redundant model-facing retrieval after equivalent information and parity
     are verified. Never invent a stored value, conceal partial evidence, or bypass source authority.
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

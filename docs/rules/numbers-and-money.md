## 7. Numbers and money (non-negotiable)
1. Money is integer cents. Never floats. Format only at display.
2. Screen numbers retain their shared definitions and canonical views. Luna independently chooses authorized operational tables, views, SQL, and the general calculator. It may derive, compare, estimate, forecast, and present hypothetical figures without a question-specific tool or requiring a verbatim source match.
3. Recorded facts must be distinguished from model-derived figures, assumptions, and estimates. Explain material assumptions and uncertainty; use exact SQL or the calculator for calculations where precision matters. Presentation is model-authored, not limited by source-literal matching. Never misrepresent an estimate as an observed fact.
4. Estimated vs actual is always labeled. Unknown is never shown as zero.
5. **Always the café's own currency** (`businesses.currency`). Never hard-code `"USD"` anywhere:
   formatting, schemas, checks or defaults. If the currency is missing, show the amount with a
   "currency not set" note.
6. Partial data never blocks an answer. Give the best labeled answer and say exactly what is missing
   (e.g. "based on 5 days of sales").
7. Use `docs/05-calculations.md` fixtures as tests. If a test disagrees with the doc, stop and ask.

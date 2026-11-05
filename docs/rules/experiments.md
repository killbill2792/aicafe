## 5. Experiments (one lifecycle)
Propose (current price, margin and expected effect from `lib/metrics/core`) → owner approves → owner
makes the POS change and confirms in chat → daily monitoring → mid-run update if notable → final report
with recommendation → owner decides to keep, revert or extend.
- The Supervisor loop (`lib/ai/supervisor/loop/`, `supervisor_proposals`, `supervisor_reports`) is the
  only experiment system. Price experiments, goals and check-ins are capabilities in it. The old owner
  initiatives system was removed; its metric list (`lib/calc/metrics/catalog.ts`), goal scoring
  (`lib/calc/goals/evaluate.ts`) and certified daily metric reader (`lib/data/metricDay.server.ts`) remain
  and are what goals use. Never add a second experiment, goal or monitor system.
- Missing or partial data never stops an experiment. The report says what was covered and how
  confident it is.

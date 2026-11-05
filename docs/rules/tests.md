## 9. Tests (rules that stop regressions)
- **Do not edit or delete an existing test unless the task explicitly names that behavior change.**
  The PR must list every test changed or deleted, each with a one-line reason. Any other test change
  is treated as a regression.
- If your change makes an existing test fail, assume your change is wrong first. Fix the code, or stop
  and ask. Never loosen the assertion.
- Test behavior, not source text. Tests that grep source files are allowed only to ban retired imports.
- No vacuous assertions (`>= 0`, `toBeDefined()` alone, `length >= 0`).
- Retries in tests use a new call ID for each new call, never a reused one.
- Unit tests for every tool handler and `checkNumbers`; recorded-fixture tests for the loop.
- **Golden owner questions:** a fixed set of real owner questions on fixture data with exact expected
  numbers, checked on both the chat and screen paths. A PR that changes any golden answer must say why.

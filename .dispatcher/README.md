# Per-repository dispatcher

Each repository owns its queue, private ledger, Muse space and ChatGPT project/account. `.dispatcher/settings.json` supplies repo-specific paths and policies. The trusted-main dispatcher runs on GitHub events and explicit delayed self-wakes; the cron remains an emergency backup. Installation and updates are reviewable PRs in each target repository, never shared runtime state.

See the plan at the top of this PR before implementation. This is owner-merge only.

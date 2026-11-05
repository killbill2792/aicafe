---
name: vitest
description: Vitest fast unit testing framework powered by Vite with Jest-compatible API. Use when writing tests, mocking, configuring coverage, or working with test filtering and fixtures.
metadata:
  author: Anthony Fu
  version: "2026.10.23"
  source: Generated from https://github.com/vitest-dev/vitest, scripts located at https://github.com/antfu/skills
---

> **AI Cafe local rules (added by AI Cafe; they override the upstream text below).**
> - Our Vitest is **5.0.2** (`package.json` `^5.0.2`); this skill was written for 5.1.0-beta.1. Not available to us: `--since-last-run`, `--last-failed`, the `cache` result store, `experimental.recordDependencies` / `vcsProvider`, `fakeTimers.fakeNodeBuiltins`, `coverage.ignoreNode`, `ui.theme` (see SOURCE.md). Check `node_modules/vitest` before using any option.
> - Available and useful: `--shard=N/3` (CI runs three shards), `--changed`, `--merge-reports`, `maxWorkers`, `test.concurrent`, test tags.
> - Do not change `vitest.config.ts`, CI sharding or existing tests unless the task names it (AGENTS.md section 9). Never add retries to hide a flaky test: fix the cause.
> - Source, pinned commit and local changes: [SOURCE.md](SOURCE.md). Index: `docs/rules/skills.md`. AGENTS.md wins over this skill.

Vitest is a next-generation testing framework powered by Vite. It provides a Jest-compatible API with native ESM, TypeScript, and JSX support out of the box. Vitest shares the same config, transformers, resolvers, and plugins with your Vite app.

**Key Features:**
- Vite-native: Uses Vite's transformation pipeline for fast HMR-like test updates
- Jest-compatible: Drop-in replacement for most Jest test suites
- Smart watch mode: Only reruns affected tests based on module graph
- Native ESM, TypeScript, JSX support without configuration
- Multi-threaded workers for parallel test execution
- Built-in coverage via V8 or Istanbul
- Snapshot testing, mocking, and spy utilities

> The skill is based on Vitest 5.1.0-beta.1, generated at 2026-10-23.

## Core

| Topic | Description | Reference |
|-------|-------------|-----------|
| Configuration | Vitest and Vite config integration, defineConfig usage | [core-config](references/core-config.md) |
| CLI | Command line interface, commands and options | [core-cli](references/core-cli.md) |
| Test API | test/it function, modifiers like skip, only, concurrent | [core-test-api](references/core-test-api.md) |
| Describe API | describe/suite for grouping tests and nested suites | [core-describe](references/core-describe.md) |
| Expect API | Assertions with toBe, toEqual, matchers and asymmetric matchers | [core-expect](references/core-expect.md) |
| Hooks | beforeEach, afterEach, beforeAll, afterAll, aroundEach | [core-hooks](references/core-hooks.md) |

## Features

| Topic | Description | Reference |
|-------|-------------|-----------|
| Mocking | Mock functions, modules, timers, dates with vi utilities | [features-mocking](references/features-mocking.md) |
| Snapshots | Snapshot testing with toMatchSnapshot and inline snapshots | [features-snapshots](references/features-snapshots.md) |
| Coverage | Code coverage with V8 or Istanbul providers | [features-coverage](references/features-coverage.md) |
| Test Context | Test fixtures, context.expect, test.extend for custom fixtures | [features-context](references/features-context.md) |
| Concurrency | Concurrent tests, parallel execution, sharding | [features-concurrency](references/features-concurrency.md) |
| Filtering | Filter tests by name, file patterns, tags | [features-filtering](references/features-filtering.md) |
| Test Tags | Label tests with tags to filter runs and apply shared options | [features-test-tags](references/features-test-tags.md) |
| Reporters | Built-in reporters, default selection, CI/output config | [features-reporters](references/features-reporters.md) |
| Benchmarking | Write benchmarks with the bench fixture (Tinybench) | [features-benchmarking](references/features-benchmarking.md) |

## Advanced

| Topic | Description | Reference |
|-------|-------------|-----------|
| Vi Utilities | vi helper: mock, spyOn, fake timers, hoisted, waitFor | [advanced-vi](references/advanced-vi.md) |
| Environments | Test environments: node, jsdom, happy-dom, custom | [advanced-environments](references/advanced-environments.md) |
| Type Testing | Type-level testing with expectTypeOf and assertType | [advanced-type-testing](references/advanced-type-testing.md) |
| Projects | Multi-project workspaces, different configs per project | [advanced-projects](references/advanced-projects.md) |

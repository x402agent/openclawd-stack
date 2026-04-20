# ClawVault OpenClaw Remediation and Extensibility Plan

## Purpose

This document turns the current OpenClaw compatibility findings into an implementation-ready plan for ClawVault. It covers:

1. the immediate OpenClaw plugin registration bug,
2. related compatibility and documentation drift,
3. a stronger extensibility architecture,
4. competitive upgrades needed to make ClawVault a serious typed-memory option again,
5. a phased rollout and validation plan.

---

## Executive Summary

ClawVault `3.5.0` currently appears incompatible with the latest OpenClaw plugin loading expectations because the exported plugin registration path is asynchronous even though the work performed during registration is synchronous. The main issue is in `src/openclaw-plugin.ts`, where both `registerOpenClawPlugin(...)` and the public `register(...)` entrypoint are declared `async`, which causes registration to return a Promise instead of a plain object.

This should be fixed first and released as a hotfix.

Separately, ClawVault has secondary issues that weaken OpenClaw compatibility and market positioning:

- tests currently reinforce the async contract,
- `compat` validates the wrong plugin manifest path,
- OpenClaw-facing docs still foreground older hook-install instructions,
- ClawVault does not yet fully capitalize on its strongest differentiator: typed, structured, auditable memory.

The plan below addresses all of those concerns.

---

## Problem Statement

### Core compatibility issue

In `src/openclaw-plugin.ts`:

- `registerOpenClawPlugin(api)` is declared `async`,
- `clawvaultPlugin.register(apiOrRuntime?)` is also declared `async`,
- but the registration body performs only synchronous setup work:
  - `readPluginConfig(api)`
  - `new ClawVaultMemoryManager(...)`
  - `api.registerTool(...)`
  - `api.on(...)`

The async keywords appear unnecessary on the registration path itself.

### Why this breaks integration

If OpenClaw expects registration to be synchronous and does not await `register(api)`, then ClawVault returning a Promise causes the registration result to be ignored or partially discarded.

### Secondary drift issues

1. The test suite currently `await`s `clawvaultPlugin.register(api)`.
2. `src/commands/compat.ts` checks `hooks/clawvault/openclaw.plugin.json`, while `package.json` points to root `./openclaw.plugin.json`.
3. Documentation still heavily uses `openclaw hooks install ...` / `openclaw hooks enable ...` wording.
4. The plugin is configurable, but the system still behaves more like a collection of features than a capability-based, extensible memory platform.

---

## Goals

## Immediate goals

- Restore compatibility with the current OpenClaw plugin contract.
- Ensure tests permanently guard the sync registration contract.
- Fix ClawVault's own compatibility checker so it validates the manifest actually being shipped.
- Refresh docs so installation, verification, and troubleshooting match the latest OpenClaw model.

## Mid-term goals

- Make the plugin runtime modular and capability-driven.
- Separate sync registration from asynchronous background memory maintenance.
- Strengthen memory retrieval around typed records, provenance, and conflict handling.

## Strategic goals

- Reposition ClawVault as a serious typed-memory system for OpenClaw.
- Add benchmarkable quality claims through evals.
- Improve extensibility so new memory features can be added safely without destabilizing plugin loading.

---

## Scope

This plan covers:

- `src/openclaw-plugin.ts`
- `src/openclaw-plugin.test.ts`
- `src/commands/compat.ts`
- `src/commands/compat.test.ts`
- `README.md`
- `SKILL.md`
- `docs/openclaw-plugin-usage.md`
- package/release validation related to `openclaw.plugin.json`
- architectural changes for future memory capabilities

This plan does not require changing the user-visible markdown vault format immediately, though it recommends stronger internal type modeling.

---

## Phase 1: Hotfix the OpenClaw Registration Contract

## 1.1 Make registration synchronous

### Current state

`src/openclaw-plugin.ts` currently declares:

- `async function registerOpenClawPlugin(...)`
- `async register(apiOrRuntime?)`

### Required change

Convert both to synchronous functions.

#### Target behavior

- `register(api)` returns the plugin registration result immediately.
- The returned object is the actual plugin object, not a Promise.
- Runtime event handlers registered via `api.on(...)` may remain async.

### Concrete implementation steps

1. Change `registerOpenClawPlugin(api: OpenClawPluginApi): Promise<...>` to `registerOpenClawPlugin(api: OpenClawPluginApi): { ... }`.
2. Remove the `async` keyword from `registerOpenClawPlugin`.
3. Remove the `async` keyword from the public `register(apiOrRuntime?)` method.
4. Preserve the existing hook-registration body.
5. Preserve the existing legacy slot/runtime path.
6. Rebuild distribution artifacts so `dist/openclaw-plugin.js` matches source.

### Non-goals for this step

- do not redesign hook logic yet,
- do not remove async hook callbacks,
- do not alter memory retrieval logic,
- do not change config semantics.

---

## 1.2 Update and harden tests

### Current issue

The test currently does this:

```ts
const result = await clawvaultPlugin.register(api);
```

That codifies the wrong behavior.

### Required test updates

1. Remove `await` from the registration test.
2. Assert registration returns a plain object synchronously.
3. Assert the return is not promise-like.
4. Keep all current behavior checks for tools, hooks, and memory slot shape.

### New regression tests to add

#### Test: sync registration contract

- call `clawvaultPlugin.register(api)`
- verify the return value exists immediately
- verify `typeof (result as any).then !== "function"`

#### Test: hook registration still occurs

- ensure the same hooks are still registered:
  - `before_prompt_build`
  - `message_sending`
  - `gateway_start`
  - `session_start`
  - `session_end`
  - `before_reset`
  - `before_compaction`
  - `agent_end`

#### Test: legacy slot registration path still works

- pass a non-OpenClaw runtime object
- verify `registerMemorySlot(...)` is invoked when appropriate
- verify a slot plugin is returned

### Success criteria

- tests fail if `register(...)` becomes async again,
- tests preserve current behavior expectations,
- tests cover both OpenClaw and non-OpenClaw registration paths.

---

## Phase 2: Repair Compatibility and Release Validation Drift

## 2.1 Fix plugin manifest path validation

### Current issue

`package.json` declares the shipped OpenClaw manifest at:

- `./openclaw.plugin.json`

But `src/commands/compat.ts` validates:

- `hooks/clawvault/openclaw.plugin.json`

This creates false negatives and weakens trust in the compatibility checker.

### Required change

Refactor `checkPluginManifest()` so it validates the actual shipped manifest path.

### Implementation options

#### Preferred option

1. Read `package.json`.
2. Inspect `openclaw.plugin`.
3. Resolve that path relative to the repo root.
4. Validate the manifest found there.

#### Acceptable fallback

If dynamic resolution is too much for now:

1. validate root `openclaw.plugin.json`,
2. optionally support legacy `hooks/clawvault/openclaw.plugin.json` only as backward compatibility.

### Additional hardening

Add a helper shared by:

- compat,
- doctor,
- any release-time validation,
- future packaging checks.

Suggested helper name:

- `resolveOpenClawPluginManifestPath(baseDir)`

### Tests to add/update

- valid root manifest passes,
- missing manifest fails with the correct path in the error message,
- config schema validation still works,
- test fails if `package.json` and compat drift again.

---

## 2.2 Align docs with the current OpenClaw installation model

### Current issue

OpenClaw-facing docs still foreground older commands like:

- `openclaw hooks install clawvault`
- `openclaw hooks enable clawvault`

Even if legacy support remains, this makes ClawVault feel behind the current OpenClaw model.

### Required change

Update all OpenClaw-facing documentation to present the current plugin workflow first.

### Files to update

- `README.md`
- `SKILL.md`
- `docs/openclaw-plugin-usage.md`
- any command hints in `doctor`, `compat`, `setup`, or user-facing command descriptions

### Documentation strategy

#### Canonical section

Add a single canonical section describing:

1. how to install ClawVault for OpenClaw today,
2. how to enable/configure it,
3. how to verify it,
4. how to troubleshoot it.

Then link to that section from all other docs.

#### Legacy path handling

If the old hook flow still works:

- label it explicitly as legacy/compatibility mode,
- do not present it as the primary install path.

### Troubleshooting updates

Update troubleshooting to reflect the current OpenClaw commands and plugin-management vocabulary.

---

## 2.3 Audit doc paths and packaging assumptions

### Current concern

Some docs refer to files or paths that may no longer represent the package layout, such as hook-oriented file organization.

### Required audit

For each of the following, confirm it exists and matches what ships:

- plugin manifest path,
- config docs path,
- OpenClaw skill/hook references,
- package metadata references,
- install/enable/verify command examples.

### Deliverable

Create a small release checklist section in docs or release tooling that verifies:

- the manifest path in `package.json` exists,
- docs point to existing files,
- setup commands match current platform behavior.

---

## Phase 3: Extensibility Architecture

## 3.1 Separate registration from orchestration and memory execution

### Current structure

`src/openclaw-plugin.ts` currently mixes:

- plugin registration,
- feature wiring,
- hook setup,
- memory runtime construction.

That is workable but not ideal for extension.

### Target architecture

Split into three layers.

#### Layer A: Registration layer

Responsibilities:

- sync `register(api)`
- tool declaration
- hook subscription
- capability declaration
- minimal runtime bootstrap

Properties:

- synchronous,
- tiny,
- low-risk,
- easy to reason about.

#### Layer B: Runtime orchestration layer

Responsibilities:

- route OpenClaw events to capabilities,
- manage feature toggles,
- schedule background work,
- enforce budgets/timeouts,
- report health and diagnostics.

#### Layer C: Memory engine layer

Responsibilities:

- schemas and typed memory records,
- indexing and retrieval,
- ranking,
- deduplication,
- contradiction handling,
- reflection/summarization,
- graph linking.

### Benefits

- safer plugin loading,
- cleaner test boundaries,
- easier future features,
- better runtime observability,
- easier integration with multiple backends.

---

## 3.2 Move from boolean flags to capability modules

### Current state

`openclaw.plugin.json` has many feature flags, such as:

- `enableStartupRecovery`
- `enableSessionContextInjection`
- `enableAutoCheckpoint`
- `enableObserveOnNew`
- `enableHeartbeatObservation`
- `enableCompactionObservation`
- `enableWeeklyReflection`
- `enableFactExtraction`
- `enableBeforePromptRecall`
- `enableMessageSendingFilter`
- `enforceCommunicationProtocol`

These are useful but mostly act as switches on a monolithic runtime.

### Target model

Introduce capability modules with a shared interface.

#### Example interface

```ts
interface PluginCapability {
  id: string;
  register?(api: OpenClawPluginApi, runtime: PluginRuntime): void;
  onGatewayStart?(event: unknown, ctx: unknown, runtime: PluginRuntime): Promise<void>;
  onSessionStart?(event: unknown, ctx: unknown, runtime: PluginRuntime): Promise<void>;
  onSessionEnd?(event: unknown, ctx: unknown, runtime: PluginRuntime): Promise<void>;
  health?(runtime: PluginRuntime): CapabilityHealth;
}
```

### Proposed capabilities

- `recall`
- `context_injection`
- `checkpointing`
- `observation`
- `fact_extraction`
- `reflection`
- `protocol_enforcement`
- `graph_linking`
- `contradiction_detection`
- `background_maintenance`

### Config evolution

Keep the current booleans as backward-compatible aliases, but move toward richer objects.

#### Example

Instead of only:

```json
{ "enableFactExtraction": true }
```

Prefer:

```json
{
  "factExtraction": {
    "enabled": true,
    "mode": "background",
    "confidenceThreshold": 0.72,
    "entityTypes": ["person", "project", "service"],
    "contradictionPolicy": "flag"
  }
}
```

### Benefits

- richer behavior without exploding boolean count,
- clearer future migrations,
- easier per-capability testing,
- more stable public API.

---

## 3.3 Add a backend abstraction for retrieval and indexing

### Why this matters

ClawVault's local markdown truth is a strength, but retrieval quality is where modern memory systems increasingly differentiate.

### Proposed abstraction

```ts
interface MemoryBackend {
  index(record: MemoryRecord): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  getById(id: string): Promise<MemoryRecord | null>;
  update(record: MemoryRecord): Promise<void>;
  delete(id: string): Promise<void>;
  health(): Promise<BackendHealth>;
}
```

### Candidate backends

- filesystem + qmd
- filesystem + lexical-only
- filesystem + hybrid lexical/semantic
- filesystem + graph-assisted retrieval

### Important design rule

The backend should optimize retrieval, not redefine the source of truth. The source of truth should remain the typed markdown record layer.

---

## 3.4 Formalize typed memory records

### Strategic position

ClawVault already presents itself as typed storage. That should become explicit in code and docs.

### Recommended core record types

- `DecisionMemory`
- `TaskMemory`
- `ObservationMemory`
- `FactMemory`
- `RelationshipMemory`
- `ProjectMemory`
- `CheckpointMemory`
- `HandoffMemory`
- `ProtocolMemory`

### Common fields

All types should share a base schema such as:

- `id`
- `type`
- `title`
- `content`
- `createdAt`
- `updatedAt`
- `source`
- `agentId`
- `projectId`
- `entities`
- `tags`
- `confidence`
- `supersedes`
- `contradicts`
- `relatedIds`
- `provenance`

### Why this matters

This creates a real differentiator over generic memory stores and makes ranking, conflict handling, and context assembly much smarter.

---

## 3.5 Add policy-driven behavior

### Current limitation

Booleans answer "on or off?" but not "how should it behave?"

### Recommended policy surfaces

- retention policy,
- summarization policy,
- contradiction policy,
- conflict resolution policy,
- privacy/sensitivity policy,
- recall ranking policy,
- stale-memory aging policy,
- task promotion policy,
- cross-agent sharing policy.

### Example

```json
{
  "recallPolicy": {
    "preferRecent": true,
    "preferActiveProject": true,
    "typeWeights": {
      "decision": 1.0,
      "task": 0.9,
      "observation": 0.5
    },
    "surfaceContradictions": true
  }
}
```

### Benefit

Policy-driven behavior scales much better than accumulating one-off feature switches.

---

## Phase 4: Competitive Upgrades

## 4.1 Build an eval harness

### Why

To be taken seriously against current memory systems, ClawVault needs measurable quality claims.

### Suggested eval dimensions

- factual recall correctness,
- temporal recall correctness,
- project/task recall,
- contradiction surfacing,
- stale-memory suppression,
- context injection usefulness,
- multi-session continuity,
- retrieval precision/recall,
- update/supersession correctness.

### Suggested repo layout

- `evals/fixtures/`
- `evals/scenarios/`
- `evals/scorers/`
- `evals/results/`
- `docs/evals.md`

### Output

A publishable benchmark story for:

- local OpenClaw memory,
- typed markdown memory,
- structured retrieval,
- contradiction-aware recall.

---

## 4.2 Add background memory maintenance

### Current hook foundation

The plugin already has lifecycle hooks wired for:

- gateway start,
- session start,
- session end,
- before reset,
- before compaction,
- agent end.

That is the right place to trigger background maintenance.

### New background jobs to add

- fact extraction queue,
- deduplication queue,
- contradiction detection,
- relationship linking,
- recap generation,
- stale-memory summarization,
- weekly reflection,
- project-state refresh.

### Important operational rule

Synchronous registration must stay fast. Background jobs should be initiated after registration, not block it.

---

## 4.3 Improve retrieval with typed ranking

### Ranking inputs to combine

- lexical relevance,
- semantic relevance,
- type affinity,
- project affinity,
- agent affinity,
- recency,
- source reliability,
- contradiction penalties,
- task/activity status,
- explicit relationship links.

### Example outcome

When the user is planning:

- prioritize active decisions and open tasks,
- include current project records,
- surface contradictory decisions if they exist,
- demote old low-confidence observations.

This is exactly where structured memory can outperform generic retrieval.

---

## 4.4 Expose more OpenClaw-native tools

### Current tools

The plugin currently exposes:

- `memory_search`
- `memory_get`

### Recommended future tools

- `memory_upsert`
- `memory_recent`
- `memory_timeline`
- `memory_for_project`
- `memory_for_agent`
- `memory_link`
- `memory_conflicts`
- `memory_explain_context`
- `memory_status`

### Why

These let an agent manage memory intentionally, not just search it.

---

## 4.5 Publish a clearer product position

### Current strongest differentiators

- local-first,
- markdown-native,
- auditable memory files,
- OpenClaw integration,
- structured memory orientation.

### Position ClawVault around

- typed memory, not just retrieval,
- durable auditable records, not opaque vectors,
- OpenClaw-native lifecycle integration,
- local-first control and inspectability,
- conflict-aware, provenance-aware recall.

### Recommended content deliverables

- `docs/why-clawvault.md`
- `docs/comparisons.md`
- `docs/evals.md`

---

## Phase 5: Release Plan

## Release 1: Compatibility hotfix

### Contents

- sync registration fix,
- test updates,
- compat manifest path fix,
- docs refresh for current install flow.

### Exit criteria

- OpenClaw loads ClawVault correctly,
- tests enforce sync registration,
- compat no longer reports false manifest failures,
- docs match current install reality.

---

## Release 2: Reliability and observability

### Contents

- shared manifest resolver,
- stronger diagnostics,
- capability registry scaffolding,
- runtime health checks,
- event timing instrumentation,
- safer failure reporting in background jobs.

### Exit criteria

- plugin runtime is diagnosable,
- failures are visible and non-silent,
- future features can land behind capability boundaries.

---

## Release 3: Typed-memory differentiation

### Contents

- explicit typed record model,
- contradiction/supersession support,
- typed retrieval/ranking,
- background memory maintenance,
- comparison docs,
- eval harness.

### Exit criteria

- ClawVault can articulate a measurable typed-memory advantage,
- retrieval quality is benchmarked,
- the system is extensible rather than feature-accumulated.

---

## Validation Checklist

## Code validation

- `register(api)` is synchronous.
- `registerOpenClawPlugin(api)` is synchronous.
- async runtime handlers still work.
- OpenClaw path and legacy slot path both pass tests.

## Packaging validation

- `package.json` manifest path exists.
- compat validates the correct manifest path.
- docs reference the same manifest path.
- release build ships the expected plugin files.

## Documentation validation

- install docs match the latest OpenClaw model.
- troubleshooting commands are current.
- legacy paths are explicitly labeled if retained.
- references to non-existent paths are removed.

## Product validation

- eval plan exists.
- typed record schema is documented.
- capability model is documented.
- roadmap aligns with ClawVault's differentiation.

---

## Risk Assessment

## Low-risk changes

- removing `async` from registration,
- updating tests,
- fixing manifest path validation,
- updating docs.

## Medium-risk changes

- introducing a shared manifest resolver,
- refactoring plugin wiring into capabilities,
- evolving config from booleans to richer objects with backward compatibility.

## High-value but longer-horizon changes

- typed ranking,
- contradiction handling,
- eval harness,
- background maintenance architecture,
- backend abstraction.

---

## Recommended Order of Work

1. Fix sync registration in `src/openclaw-plugin.ts`.
2. Update `src/openclaw-plugin.test.ts` to enforce sync registration.
3. Fix `src/commands/compat.ts` manifest-path resolution.
4. Update `src/commands/compat.test.ts`.
5. Refresh OpenClaw install and troubleshooting docs.
6. Add shared manifest resolver and release validation checks.
7. Introduce capability-based runtime structure.
8. Formalize typed memory schemas.
9. Add eval harness.
10. Ship comparison and positioning docs.

---

## Final Recommendation

If only one thing happens immediately, it should be this:

- make plugin registration synchronous again and ship a hotfix.

If the goal is to make ClawVault a serious OpenClaw memory competitor again, the full path is:

- fix the sync contract,
- repair manifest/docs drift,
- modularize capabilities,
- formalize typed memory,
- benchmark retrieval quality,
- and market ClawVault around auditable structured memory rather than generic memory search.

That combination addresses both the immediate bug and the broader extensibility/competitiveness concerns.

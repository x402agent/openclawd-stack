# ClawVault Plugin Migration & Enhancement Brief

## Context
ClawVault is an AI agent memory system (npm: clawvault, 503 stars). It currently has a legacy OpenClaw hook handler (`hooks/clawvault/handler.js`, 1100+ lines) that works via shell events and event.messages mutation. The actual plugin entry (`src/openclaw-plugin.ts`) is a 10-line stub.

OpenClaw recently added `before_prompt_build` hook with `prependSystemContext`/`appendSystemContext` for injecting into the system prompt layer (provider-cacheable). There's also `message_sending` for outbound filtering. These are the NEW way to build memory plugins.

## Goal
Transform ClawVault into the definitive OpenClaw memory plugin that fills `plugins.slots.memory` and is strictly better than the bundled alternatives.

## Competing Memory Plugins to Beat

### 1. memory-core (bundled default)
- Basic `memory_search` (semantic) + `memory_get` (file read) tools
- Uses SQLite + embeddings for vector search
- FTS (full-text search) support
- Embedding cache
- No `before_prompt_build` usage (just provides tools)
- No auto-recall, no context injection, no communication protocol

### 2. memory-lancedb (bundled alternative)
- Set via `plugins.slots.memory = "memory-lancedb"`
- Uses LanceDB for vector storage
- Auto-recall and capture capabilities
- More advanced but still limited to tool-level interaction

### 3. QMD backend (experimental)
- Set via `memory.backend = "qmd"`
- BM25 + vectors + reranking (local-first via Bun + node-llama-cpp)
- Most sophisticated search, but just a backend — no prompt injection

## What ClawVault Must Do Better Than ALL of Them

### A. `before_prompt_build` Hook (HIGHEST PRIORITY)
Use `api.on("before_prompt_build", ...)` to:
1. **Force memory recall** — Inject `prependSystemContext` that mandates `memory_search` before answering questions about prior work, people, decisions, preferences, or todos
2. **Inject vault context** — Based on the incoming `event.prompt`, search the vault and inject relevant memories via `prependSystemContext` so the agent has context BEFORE reasoning
3. **Communication protocol** — Use `appendSystemContext` to enforce behavioral rules:
   - Never say "good catch", "great question", "you're right to call that out"
   - Never offer "if you'd like I can..." rabbit holes
   - Never ask questions the vault already has answers to
   - Use memory tools proactively, not reactively

### B. `message_sending` Hook (Outbound Filter)
Use `api.on("message_sending", ...)` to:
1. Detect and rewrite messages containing banned patterns
2. Block messages that ask questions the vault has answers for
3. Enforce communication protocol compliance before delivery

### C. Proper Plugin Registration
- Register with `kind: "memory"` for `plugins.slots.memory` slot
- Use `api.on(...)` typed hooks, not legacy shell events
- Implement `MemorySearchManager` interface (search, readFile, status, sync, probeEmbeddingAvailability, probeVectorAvailability)
- Register `memory_search` and `memory_get` tools via `api.registerTool()`

### D. All Existing handler.js Functionality (Migrated)
- `gateway_start` → context death detection + recovery
- `session_start` → session recap + vault memory injection (now via `before_prompt_build` instead of message mutation)
- `before_reset` → auto-checkpoint + observer flush (replaces command:new)
- Heartbeat → active session observation
- Compaction → forced observer flush
- Fact extraction → entity graph building
- Weekly reflection

## Technical Requirements

### File Structure
```
src/openclaw-plugin.ts          ← Main plugin entry (rewrite from stub)
src/plugin/                     ← New directory for plugin modules
  hooks/                        ← Hook implementations
    before-prompt-build.ts
    message-sending.ts
    session-lifecycle.ts
    observation.ts
  memory-manager.ts             ← MemorySearchManager implementation
  communication-protocol.ts     ← Banned patterns, rewrite rules
  vault-context-injector.ts     ← Search vault and format context for injection
  fact-extractor.ts             ← Migrated from handler.js
```

### Key Types (from OpenClaw SDK)
See `.cursor-context/openclaw-plugin-types.d.ts` for full types:
- `PluginHookBeforePromptBuildEvent` → `{ prompt, messages }`
- `PluginHookBeforePromptBuildResult` → `{ prependSystemContext?, appendSystemContext?, prependContext?, systemPrompt? }`
- `PluginHookMessageSendingEvent` → `{ to, content, metadata? }`
- `PluginHookMessageSendingResult` → `{ content?, cancel? }`
- `MemorySearchManager` interface → `{ search, readFile, status, sync?, probeEmbeddingAvailability, probeVectorAvailability, close? }`

### Plugin API Pattern
```typescript
export default function register(api) {
  api.on("before_prompt_build", async (event, ctx) => {
    // Search vault based on event.prompt
    // Return { prependSystemContext, appendSystemContext }
  }, { priority: 10 });

  api.on("message_sending", async (event, ctx) => {
    // Check event.content against communication protocol
    // Return { content: rewritten } or void
  });

  api.registerTool(memorySearchToolFactory);
  api.registerTool(memoryGetToolFactory);
}
```

### Constraints
- Keep ALL existing handler.js functionality (migrate, don't delete)
- Keep backward compatibility with existing openclaw.plugin.json config schema
- Zero new runtime dependencies (use Node.js built-ins)
- The plugin must work both as slot:memory replacement AND alongside existing tools
- Use existing ClawVault CLI (`clawvault`) for vault operations where needed
- Maintain the security hardening (execFileSync, integrity checks, input sanitization)
- All existing tests must continue passing

### Key Reference Files
- `.cursor-context/openclaw-plugin-docs.md` — Full plugin authoring docs
- `.cursor-context/openclaw-plugin-types.d.ts` — TypeScript type definitions
- `.cursor-context/openclaw-memory-types.d.ts` — MemorySearchManager interface
- `.cursor-context/openclaw-memory-docs.md` — How OpenClaw memory works
- `.cursor-context/openclaw-agent-loop.md` — Agent loop and prompt build order
- `hooks/clawvault/handler.js` — Existing legacy handler to migrate from
- `hooks/clawvault/integrity.js` — Security utilities to reuse
- `openclaw.plugin.json` — Existing manifest (update, don't replace)
- `src/openclaw-plugin.ts` — Current stub (rewrite)

## Definition of Done
1. `src/openclaw-plugin.ts` is a full plugin using `api.on(...)` hooks
2. `before_prompt_build` injects vault context + memory recall mandate + comms protocol
3. `message_sending` filters outbound messages against comms protocol
4. All handler.js functionality migrated to new hook system
5. Plugin registers `kind: "memory"` and implements MemorySearchManager
6. Registers memory_search and memory_get tools
7. openclaw.plugin.json manifest updated
8. All existing tests pass
9. `npm run build` passes
10. New tests for the hook implementations

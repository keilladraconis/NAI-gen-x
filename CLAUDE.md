# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NAI-gen-x is a NovelAI Script module — a queued generation engine (`GenX` class) that wraps the NovelAI Scripting API (`api.v1`) with budget management, exponential backoff for transient errors, and reactive state. It runs inside NovelAI's scripting runtime, not as a standalone Node.js application.

## Build & Type Checking

There is no build step or bundler — the project uses `noEmit` TypeScript for type-checking only. There is no package.json yet.

```bash
npx tsc --noEmit        # Type-check the project
```

## Architecture

- **`src/gen-x.ts`** — The entire library. Exports the `GenX` class, `GenerationState` interface, and `MessageFactory` type.
- **`external/script-types.d.ts`** — Ambient type declarations for the NovelAI Scripting API (`api.v1`, `Message`, `GenerationParams`, `CancellationSignal`, etc.). These types are globally available — no imports needed.

### GenX Class Design

Single-threaded queue processor: tasks are enqueued via `generate()` and processed sequentially by `processQueue()` → `executeTask()`.

Key concepts:
- **MessageFactory**: a `() => Promise<{messages, params?}>` function resolved JIT when a task is picked off the queue, enabling deferred strategy building.
- **Budget management**: `ensureBudget()` checks the platform's output token allowance (`api.v1.script.getAllowedOutput`) and waits if needed, transitioning through `waiting_for_user` → `waiting_for_budget` states.
- **Transient error retry**: exponential backoff (2^n seconds) up to `maxRetries` (default 5) for network/timeout/abort errors.
- **State machine**: `idle → queued → generating → completed/failed`, with `waiting_for_budget` and `waiting_for_user` side states. State changes are broadcast to subscribers and hooks.
- **Hooks**: `onStateChange`, `onTaskStarted`, `beforeGenerate` — for integrating with UI stores.

## TypeScript Conventions

- Strict mode with `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`
- Target ES2023, module resolution `bundler`
- Tests use vitest globals (types registered in tsconfig)

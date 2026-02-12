# nai-gen-x

A queued generation engine for [NovelAI Scripts](https://docs.novelai.net/Scripting). Wraps the `api.v1` scripting API with sequential queue processing, budget management, exponential backoff for transient errors, and reactive state.

## Installation

### Method A: Copy-paste (simplest)

Copy `src/gen-x.ts` directly into your NovelAI Script project.

### Method B: npm + nibs

If your project uses [nibs](https://github.com/LaneRendell/NovelAI_Script_BuildSystem) or another bundler that resolves `node_modules`:

```bash
npm install nai-gen-x
```

```ts
import { GenX } from "nai-gen-x";
```

> **Note:** This package distributes raw TypeScript source — no compilation step is needed. Your bundler must support `.ts` imports.

## Quick Start

```ts
import { GenX } from "nai-gen-x";

const genx = new GenX({
  onStateChange(state) {
    console.log("State:", state.status);
  },
});

const response = await genx.generate(
  [{ role: "user", content: "Hello!" }],
  { model: "glm-4-6", max_tokens: 200 },
);
```

### Using a MessageFactory (JIT strategy building)

```ts
const response = await genx.generate(
  async () => {
    // Called when this task is picked off the queue — not when enqueued
    const context = await buildContext();
    return {
      messages: context.messages,
      params: { max_tokens: context.budget },
    };
  },
  { model: "glm-4-6", max_tokens: 200 },
);
```

## Features

### Queue Processing

Tasks are enqueued via `generate()` and processed sequentially. This prevents concurrent API calls and ensures orderly generation.

### MessageFactory / JIT Resolution

Pass a function instead of a message array to `generate()`. The factory is called just-in-time when the task is picked off the queue, enabling deferred strategy building based on the latest state.

### Budget Management

Before each generation, GenX checks the platform's output token allowance via `api.v1.script.getAllowedOutput`. If budget is insufficient, it transitions through `waiting_for_user` and `waiting_for_budget` states, then resumes automatically when tokens become available.

### Transient Error Retry

Network errors, timeouts, and aborted requests are retried with exponential backoff (2^n seconds) up to `maxRetries` (default: 5).

### Reactive State

Subscribe to state changes to drive UI updates. The state machine broadcasts every transition to registered listeners and hooks.

### Cancellation

Cancel individual queued tasks with `cancelQueued(taskId)`, or cancel everything (queued + in-progress) with `cancelAll()`. Pass a `CancellationSignal` to `generate()` for fine-grained control.

## API Reference

### `new GenX(hooks?)`

Creates a new GenX instance.

| Parameter | Type | Description |
|-----------|------|-------------|
| `hooks` | `GenXHooks` | Optional lifecycle hooks |

### `genx.state`

Returns a snapshot of the current `GenerationState`.

### `genx.subscribe(listener)`

```ts
const unsubscribe = genx.subscribe((state) => {
  console.log(state.status, state.queueLength);
});
```

Registers a listener called on every state change. The listener receives an immediate call with the current state. Returns an unsubscribe function.

### `genx.generate(messages, params, callback?, behaviour?, signal?)`

```ts
generate(
  messages: Message[] | MessageFactory,
  params: GenerationParams & {
    minTokens?: number;
    maxRetries?: number;
    taskId?: string;
  },
  callback?: (choices: GenerationChoice[], final: boolean) => void,
  behaviour?: "background" | "blocking",
  signal?: CancellationSignal,
): Promise<GenerationResponse>
```

Enqueues a generation request. Parameters mirror `api.v1.generate` with additional options:

| Parameter | Type | Description |
|-----------|------|-------------|
| `messages` | `Message[] \| MessageFactory` | Messages array or factory function for JIT resolution |
| `params` | `GenerationParams & extras` | Generation parameters (see below) |
| `callback` | `function` | Optional streaming callback |
| `behaviour` | `string` | `"background"` or `"blocking"` |
| `signal` | `CancellationSignal` | Optional cancellation signal |

**Extra params:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minTokens` | `number` | `1` | Minimum tokens required for budget check |
| `maxRetries` | `number` | `5` | Max transient error retries |
| `taskId` | `string` | `api.v1.uuid()` | Custom task identifier |

### `genx.getTaskStatus(taskId)`

Returns `"queued"`, `"processing"`, or `"not_found"`.

### `genx.cancelQueued(taskId)`

Removes a task from the queue. Returns `true` if the task was found and cancelled or was already absent.

### `genx.cancelAll()`

Cancels all queued tasks and the currently executing task (if any).

### `genx.userInteraction()`

Manually signal a user interaction to transition from `waiting_for_user` to `waiting_for_budget`. This is called automatically when the user clicks "Generate" in the NovelAI UI.

## Types

### `GenerationState`

```ts
interface GenerationState {
  status:
    | "idle"
    | "queued"
    | "generating"
    | "waiting_for_budget"
    | "waiting_for_user"
    | "completed"
    | "failed";
  error?: string;
  queueLength: number;
  budgetWaitEndTime?: number;
}
```

### `MessageFactory`

```ts
type MessageFactory = () => Promise<{
  messages: Message[];
  params?: Partial<GenerationParams>;
}>;
```

### `GenXHooks`

```ts
interface GenXHooks {
  onStateChange?(state: GenerationState): void;
  onTaskStarted?(taskId: string): void;
  beforeGenerate?(taskId: string, messages: Message[]): void;
}
```

## State Machine

```
         ┌─────────────────────────────┐
         │                             │
         ▼                             │
       idle ──► queued ──► generating ─┤──► completed
                              │        │
                              ▼        │
                      waiting_for_user │
                              │        │
                              ▼        │
                     waiting_for_budget │
                              │        │
                              ▼        │
                          generating ──┘──► failed
```

## License

[MIT](LICENSE)

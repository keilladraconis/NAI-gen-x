# gen-x — Refactor Plan

Status: **Complete** (v0.3.0)

## 1. Fix `cancelAll()` promise leak (bug)

When `cancelAll()` clears the queue, queued tasks' `reject` callbacks are never called. Their promises hang forever — callers awaiting them will never resolve.

```ts
// Before
public cancelAll() {
  this.queue = [];
  // ... only handles currentTask

// After
public cancelAll() {
  const abandoned = this.queue.splice(0);
  for (const task of abandoned) {
    task.signal?.cancel();
    task.reject("Cancelled");
  }
  // ... rest of currentTask handling unchanged
```

## 2. Remove dead `_min` parameter

`ensureBudget` accepts `_min` but never reads it. Either use it (compare against `getAllowedOutput` for partial-budget generation) or remove it.

```ts
// Before
private async ensureBudget(requested: number, _min: number, signal?: CancellationSignal)

// After — if removing
private async ensureBudget(requested: number, signal?: CancellationSignal)
```

Update the call site in `executeTask` accordingly.

## 3. Use `Set` for listeners (cleanup)

`listeners` is an array, and `unsubscribe` uses `filter()` to create a new array every time. Use a `Set` like nai-store does:

```ts
// Before
private listeners: ((state: GenerationState) => void)[] = [];
// unsubscribe: this.listeners = this.listeners.filter(l => l !== listener)

// After
private listeners = new Set<(state: GenerationState) => void>();
// unsubscribe: this.listeners.delete(listener)
```

## 4. Immutable state updates (cleanup)

`updateState` mutates `_state` via `Object.assign` then spreads for the snapshot. Use immutable update for consistency:

```ts
// Before
private updateState(partial: Partial<GenerationState>) {
  Object.assign(this._state, partial);
  const snapshot = { ...this._state };

// After
private updateState(partial: Partial<GenerationState>) {
  this._state = { ...this._state, ...partial };
  const snapshot = { ...this._state };
```

# Changelog

## [0.5.0] - 2026-08-25

### Added

- **`fastRejection` generation flag** — pass `fastRejection: true` in `generate()` params and the request never queues and never enters a `waiting_for_*` state. If the engine is busy, or if the input/output budget is insufficient, the promise rejects immediately with a `FastRejectionError` (`reason: "busy" | "budget"`, plus a `retryAfterMs` hint for budget rejections) *before* either `waitForAllowedOutput`/`waitForAllowedInput` call. Intended for unobtrusive, opportunistic background processors that run their own retry loop — a queued or waiting state would otherwise make the UI claim the user must click Generate and wait for budget.
- **`isFastRejection(e)` type guard** and exported `FastRejectionError` / `FastRejectionReason`.

### Changed

- **Retries default to 0 under `fastRejection`** — the engine no longer sleeps through exponential backoff on behalf of a fast-rejection caller (an explicit `maxRetries` is still honoured). Fast rejections and exhausted transient errors on these tasks do not broadcast a `failed` status; genuine generation errors still do.

## [0.4.0] - 2026-04-10

### Added

- **Input budget checking** — `ensureBudget` now checks `getAllowedInput()` alongside `getAllowedOutput()`. If either budget is insufficient, the engine waits; if both are blocking, the budget with the greater wait time is awaited first (the shorter one will have resolved by then). `budgetWaitEndTime` reflects the true blocking duration (`max` of both waits).

## [0.3.0] - 2026-03-16

### Fixed

- **`cancelAll()` promise leak** — queued tasks now have their promises properly rejected when the queue is cleared. Previously, callers awaiting queued tasks would hang forever.

### Changed

- **Removed dead `minTokens` parameter** — `generate()` and the internal `ensureBudget()` no longer accept `minTokens`. The parameter was never read and had no effect.
- **`listeners` converted from array to `Set`** — `subscribe`/`unsubscribe` now use `Set.add`/`Set.delete` instead of `filter`, consistent with nai-store.
- **Immutable state updates** — `updateState` now replaces `_state` via object spread instead of mutating it with `Object.assign`.

## [0.2.0]

Initial public release.

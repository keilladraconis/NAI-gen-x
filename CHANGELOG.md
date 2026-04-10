# Changelog

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

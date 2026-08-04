# ADR-0003 — Two-sided Clean Architecture with ports at every boundary

- Status: accepted
- Date: 2026-08-04

## Context

The app spans two processes (TypeScript webview, Rust shell). We want the
maintainability properties Uncle Bob's Clean Architecture promises:
framework-independent, testable-in-isolation business rules, and
replaceable details.

## Decision

Apply the Dependency Rule independently on both sides, with the
application's real logic concentrated in the TypeScript core:

- **Frontend:** `entities → usecases/state → ports` form the core;
  `adapters/tauri` implements the ports; `ui` is a humble view;
  `wiring/context.ts` is the composition root (the case study's `Context`).
- **Backend:** `agent-core` is a pure domain crate (events + provider
  adapters, no I/O); the `mota-editor` crate is shell — controllers
  (`commands.rs`) and drivers (`runner.rs`, `workspace_file.rs`).
- State is held in a framework-free reducer + observable store; React
  subscribes through one hook (`useAppState`).
- Only DTOs cross process and layer boundaries.

## Consequences

- Every business rule is unit-tested without React, Tauri, or a child
  process (15 vitest tests + 17 cargo tests at the time of writing, all
  sub-second).
- Adding a provider touches: one Rust file + the provider registry + one
  entry in the frontend `PROVIDERS` list. Nothing else.
- Replacing Tauri, React, or the store mechanism each touches exactly one
  outer directory.
- Cost accepted: more files and indirection than a quick hack. That is
  the price of the boundaries, paid deliberately.

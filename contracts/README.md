# Contracts (ARCHITECTURE Phase B)

This directory is the **source of truth for the seams** between the shared Core and
the three clients.

- [`ports.d.ts`](ports.d.ts) — the platform port interfaces every client implements
  (camera, detectors, blur, recorders, audio monitor, speech, motion, deterrent
  speaker, secure store, keep-awake) plus the capability-report shape. TypeScript is
  used as a precise IDL; Swift/Kotlin adapters mirror these shapes.

## Rules

1. **Adapters hold no decisions.** If an adapter needs a number or a rule, that
   number belongs in `core/src/config.js` and the rule in a Core module. Review
   heuristic: a threshold inside `clients/` or `web-poc/` is a bug.
2. **Conformance is fixture-based, not compiler-based.** Every client runs the SAME
   golden fixtures (`core/fixtures/`) through its embedded Core:
   - web/node: `node core/test/run.mjs` (CI: `core-tests.yml`)
   - iOS: XCTest target driving JavaScriptCore (Phase C)
   - Android: instrumented test driving the JS engine (Phase D)
3. **Capability honesty.** Each adapter reports what it can do (and whether it is
   self-contained) at startup; the Core merges reports over conservative defaults
   and the UI shows degradations with a reason. No `if (platform == …)` feature
   gates anywhere else.
4. **Time is monotonic ms** everywhere in the pipeline; wall-clock only for
   user-facing display and storage metadata.
5. **Audit chains must be byte-identical across platforms**: SHA-256 over the
   Core's canonical serialization (see `core/src/audit.js`), verified by the
   `audit-chain.json` fixture.

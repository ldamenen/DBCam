# DBCam

Session-based privacy body-cam: faces are blurred live; flagging an incident seals the
unblurred footage (including the buildup) for authorized review. Fully self-contained —
no servers, no accounts; everything runs and stays on the device.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the three-client architecture
  (Web · iOS native · Android native) with a shared decision Core: one feature,
  implemented once, effective on all clients unless a platform can't support it.
- **[core/](core/)** — the shared decision Core (policy, threat scoring, incidents,
  sealing rules, audit chain, config) + golden fixtures: `node core/test/run.mjs`.
- **[web-poc/](web-poc/)** — the web client, fully self-contained (models vendored,
  offline after first load). Live demo: https://ldamenen.github.io/DBCam/
  Local run: `python3 -m http.server 8000` at the repo root → `http://localhost:8000/web-poc/`

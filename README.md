# DBCam

Session-based privacy body-cam: faces are blurred live; flagging an incident seals the
unblurred footage (including the buildup) for authorized review. Fully self-contained —
no servers, no accounts; everything runs and stays on the device.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the three-client architecture
  (Web · iOS native · Android native) with a shared decision Core: one feature,
  implemented once, effective on all clients unless a platform can't support it.
- **[web-poc/](web-poc/)** — the working web client (current prototype).
  Live demo: https://ldamenen.github.io/DBCam/

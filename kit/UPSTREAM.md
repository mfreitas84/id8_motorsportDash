# Vendored MGU App Kit

This folder is a copy of `kit/` from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), MIT License (see `LICENSE` here), Copyright (c) 2026 cauliflowermossgrape.

| | |
|---|---|
| Commit | [`f54fc279d309ca12eba129b676d755c6f02f5a06`](https://github.com/cauliflowermossgrape/idrive7-apps/tree/f54fc279d309ca12eba129b676d755c6f02f5a06/kit) |
| Date | 2026-11-26 |
| Files | 112 |

Don't edit files here: change them upstream or in `apps/`, then re-run
`python tools/sync_kit.py <idrive7-apps clone>`. What is left out and why is at the top of
`tools/sync_kit.py` (the GPL-3.0 renderer and emulator, upstream icons and tests, and the
ru / zh-CN fault-text databases).

## Local patches (re-applied by every sync, marked `[id8 patch]` in the code)

- `kit/runtime/mgu.js`: lets an app switch the kit's data/<id>.log off completely (Settings > Logging = Off)

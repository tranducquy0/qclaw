# anclaw

A general agent runtime for Termux/Android and other low-end hosts.

- **Channels:** CLI, Telegram, IRC
- **Tools:** shell, read/write, search (`rg`→`grep` fallback), web (search via Exa / fetch via HTML-stripped curl)
- **LLM:** any OpenAI-compatible endpoint + ChatGPT/Codex OAuth
- **Token budget:** caveman system prompt + context packing + tool-output truncation
- **Dual target:** Node >= 18 *or* quickjs-ng (`qjs -m`). All I/O goes through `src/platform.js`; adapters in `src/adapters/`.

## Run

```sh
./anclaw.sh            # node if present, else qjs
./anclaw.sh qjs        # force quickjs-ng
node test/smoke.js     # pure smoke tests (run on both targets)
```

Config lives at `~/.anclaw/config.toml` — see `config.example.toml`.

## Layout

```
src/platform.js      I/O contract (http, tcp, exec, fs, io, time) — the only host boundary
src/adapters/node.js adapter: fetch / node:net / child_process
src/adapters/qjs.js  adapter: curl subprocess / std.connectTCP / std+os
src/config.js        TOML-subset reader + defaults
src/index.js         boot + self-check
```

## Status

- [x] Phase 0 — repo, platform contract, node + qjs adapters, TOML config, self-check
- [ ] Phase 1 — core loop, budget/packing, caveman prompt, CLI channel, Codex OAuth
- [ ] Phase 2 — Telegram channel
- [ ] Phase 3 — IRC channel
- [ ] Phase 4 — full tools + `bench.js` (qjs vs node decision data)

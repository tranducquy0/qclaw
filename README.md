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

First run with no config scaffolds `~/.anclaw/config.toml` from defaults — edit it and restart. `PREFIX` and `TMPDIR` env vars are honored by the adapters (`$PREFIX/bin/sh` when it exists, `$TMPDIR` > `$PREFIX/tmp` > `/tmp`).

### ChatGPT / Codex login

Use the ChatGPT plan as the LLM instead of an API key:

1. In `~/.anclaw/config.toml` set:
   ```toml
   [llm]
   provider = "codex"
   model = "gpt-5-codex"     # set to the model your plan offers
   ```
2. Run `./anclaw.sh`, then type `/login`. It prints an `auth.openai.com` URL.
3. Open the URL, sign in; the browser lands on `http://localhost:1455/auth/callback?code=...` (anclaw has no local listener — that page just errors). Copy the full callback URL from the address bar and paste it at the `>` prompt.
4. Tokens land in `~/.anclaw/auth.json`; refresh is automatic — `/login` again only if a refresh fails. Chat goes through the Codex Responses API on the ChatGPT backend.

To drop back to an API key: set `provider = "openai"`, `apiKey = "sk-..."`.

Template checks: `caveman-blocks run boot-check --engine node` and `caveman-blocks run login-check --engine qjs`.

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
- [x] Phase 0.5 — native module `anclaw_net.so` (in-process curl + raw sockets)
- [x] Phase 1 — LLM client (+ Codex OAuth), budget/packing, caveman prompt, agent loop, CLI channel, mock-LLM e2e test (7/7)
- [ ] Phase 2 — Telegram channel
- [ ] Phase 3 — IRC channel
- [ ] Phase 4 — tool hardening + full `bench.js` decision data
- [ ] verify: qjs runtime boot (needs a live-mock fixture not node-dependent)

// runtime_test.js — end-to-end agent loop against a scripted mock LLM.
// node test/runtime_test.js
"use strict";

import * as http from "node:http";
import { LLMClient } from "../src/llm/client.js";
import { Registry } from "../src/tools/registry.js";
import { registerCoreTools } from "../src/tools/core.js";
import { Runtime } from "../src/runtime.js";
import { Session, serializeSession, parseSession } from "../src/core/budget.js";

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}${detail !== undefined ? ":\n  " + detail : ""}`);
}

// ---- scripts the mock LLM follows ------------------------------------------
// each script: { start: regex to detect the user turn,
//                steps: [ {tool} | {text} ] } — a new script resets the step
const SCRIPTS = [
  {
    start: /find TODOs/,
    steps: [
      { tool: "search", arguments: JSON.stringify({ query: "TODO" }) },
      { text: "Found TODOs: 2" },
    ],
  },
  {
    start: /exercise file tools/,
    steps: [
      { tool: "write", arguments: JSON.stringify(
          { path: "j_test.txt", content: "hello" }) },
      { tool: "read", arguments: JSON.stringify({ path: "j_test.txt" }) },
      { text: "done" },
    ],
  },
];

const srv = http.createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const lastUser = [...body.messages].reverse()
      .find((m) => m.role === "user")?.content || "";

    const cur = SCRIPTS.find((sc) => sc.start.test(lastUser));
    // reset step only for a NEW user turn (last user msg changed)
    if (cur && lastUser !== srv.lastUser) {
      srv.script = cur; srv.step = 0; srv.lastUser = lastUser;
    }
    if (!srv.script) { res.writeHead(500); res.end(); return; }
    const out = srv.script.steps[srv.step] ||
      { text: "[script exhausted]" };
    srv.step++;

    const message = out.tool
      ? { content: "", tool_calls: [{ id: "c1", type: "function",
          function: { name: out.tool, arguments: out.arguments } }] }
      : { content: out.text };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message }], usage: {} }));
  });
});

const port = await new Promise((r) => {
  srv.listen(0, () => r(srv.address().port));
});

// fake platform for the tools that need fs/exec (search blocked is fine)
const store = new Map();
const P = {
  name: "test",
  homeDir: "/tmp",
  async httpFetch() { throw new Error("platform http not used in test"); },
  async exec() { throw new Error("exec not used in test"); },
  async fsRead(p) { return store.has(p) ? store.get(p) : null; },
  async fsWrite(p, d) { store.set(p, d); },
  async fsStat() { return { exists: false, size: 0, isDir: false }; },
  async fsList() { return []; },
  async fsMkdir() {},
  async fsUnlink() {},
  time: {},
  sha256: null,
  io: { async readLine() { return null; }, async write() {} },
};

const registry = new Registry();
registerCoreTools({
  reg: registry, P,
  root: "/tmp",
  maxOutput: 4000,
  webFetchMax: 5000,
  exaKey: "",
});

const llm = new LLMClient(
  { provider: "openai", baseURL: `http://127.0.0.1:${port}`,
    apiKey: "test", model: "mock" },
  { http: (url, opts) => mockHttp(port, url, opts), fs: P, io: P.io });

const rt = new Runtime({
  client: llm, registry,
  opts: { channel: "cli", budget: 4000, maxTurns: 8, cwd: "/tmp",
    maxOutput: 4000 },
});

// ---- run ----------------------------------------------------------------
const s = new Session("t");

{
  const r = await rt.handle(s, "find TODOs");
  ok("turn1 reply", /Found TODOs: 2/.test(r), r);
}
{
  const r = await rt.handle(s, "exercise file tools");
  ok("turn2 reply", /done/.test(r), r);
  const file = await P.fsRead("/tmp/j_test.txt");
  ok("write tool stored", file === "hello", JSON.stringify(file));
}
{
  const repo = JSON.parse(serializeSession(s));
  ok("session has 2 turns", repo.turns.length === 2, JSON.stringify(repo.turns?.length));
  const back = parseSession(serializeSession(s));
  ok("session roundtrip", back.turnCount === 2);
  // messages included?
  ok("turn messages captured",
    repo.turns[1].messages.length >= 3,
    JSON.stringify(repo.turns[1].messages));
}
{ // jail check
  let msg;
  try {
    await registry.get("write").run(
      { path: "/tmp/../tmp/outside_test.txt", content: "x" }, { cwd: "/tmp" });
    // /tmp is the root -> allowed. use a clearly-jail-breaching path:
  } catch (e) { msg = e.message; }
  try {
    await registry.get("write").run({ path: "/etc/hosts", content: "x" },
      { cwd: "/tmp" });
    ok("jail rejects", false, "no error thrown");
  } catch (e) {
    ok("jail rejects", /outside workspace/.test(e.message));
  }
}
srv.close();
console.log(`runtime_test: ${pass} passed, ${fail} failed`);
if (globalThis.process) process.exit(fail ? 1 : 0);
else if (globalThis.std?.exit) std.exit(fail ? 1 : 0);

// minimal glue: platform contract httpFetch(url, opts) -> mock adapter
function mockHttp(portNo, url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const where = {
      host: "127.0.0.1", port: portNo, path: u.pathname,
      method: o.method || "GET", headers: o.headers,
    };
    const req = http.request(where, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: {}, body: b }));
    });
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

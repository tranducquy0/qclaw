// qjs adapter — quickjs-ng implementation of the platform contract.
//
// Run with:  qjs --std -m src/index.js     (--std exposes global std/os)
//
// HTTPS goes through the curl binary (termux-main ships it). Subprocess
// via std.popen. Timers via os.setTimeout. Files via std/os.
// Everything here accepts a slower path than Node; this is what bench.js
// compares against the node adapter (cold start & RSS included).
//
// Known limits of the ng build as shipped by termux (0.17.0):
//   - std.connectTCP does not exist -> plain TCP (IRC) needs the socat
//     subprocess bridge (phase 3) — HTTPS channels unaffected (curl).
//   - no per-response headers from the curl shim (not needed in v0).
//   - popen is read-only: exec() stdin is a temp-file redirect instead.

"use strict";

// NOTE: Termux's (and ng's) qjs exposes std/os/bjson ONLY under the --std
// flag, and only as *global objects* — `import "std"` throws
// "could not load module filename".
const std = globalThis.std;
const os = globalThis.os;
import { PlatformError } from "../platform.js";

if (!std || !os) {
  throw new PlatformError(
    "qjs: std/os not loaded — run with: qjs --std -m src/index.js");
}

// Optional native module (src/native/anclaw_net.so — build via
// src/native/build.sh). In-process libcurl + raw sockets: kills the
// fork-per-request latency AND provides the plain TCP that this qjs
// build lacks (std.connectTCP absent). Falls back to the curl shim
// and an explicit TCP error when absent.
let native = null;
try {
  native = (await import("../native/anclaw_net.so")).default;
} catch (e) {
  // no native module — adapters keep working, just slower on http and
  // no plain TCP.
  void e;
}

// Normalize console. ng ships a console, but verify each method — some
// builds only have log (found the hard way: console.error missing on
// Termux 0.17.0 → masked the original boot error).
if (typeof globalThis.console !== "object" || !globalThis.console) {
  globalThis.console = {};
}
for (const m of ["log", "info", "warn", "error"]) {
  if (typeof globalThis.console[m] !== "function") {
    globalThis.console[m] = (...a) => {
      std.out.puts(a.map((x) =>
        typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
      std.out.flush();
    };
  }
}

const MARKER = "__ANCLAW_HTTP__";
const TMPDIR = "/data/data/com.termux/files/usr/tmp";
let tmpSeq = 0;

// ---- helpers ---------------------------------------------------------------
function shellQuote(s) { return `'${s.replace(/'/g, "'\\''")}'`; }

function toStr(x) {
  if (typeof x === "string") return x;
  const u = x instanceof Uint8Array ? x : new Uint8Array(x);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return s;
}

// Read a std/os file/popen object to EOF using ng's buffer-based read().
// Passing a reusable 64KB ArrayBuffer: 75 dumps => ~4.8MB ceiling per call.
function readAll(handle) {
  const buf = new ArrayBuffer(65536);
  let out = "";
  for (;;) {
    const n = handle.read(buf);
    if (n === null || n === undefined || n <= 0) break;
    out += toStr(new Uint8Array(buf, 0, n));
  }
  return out;
}

function dirname(path) {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

function mkdirp(path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try { os.mkdir(cur, 0o755); } catch (e) { /* exists */ }
  }
}

// ---- HTTP: native in-process curl first, subprocess curl shim fallback -------
async function httpFetch(url, opts = {}) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new PlatformError(`httpFetch: bad url: ${url}`);
  }
  if (native?.httpRequest) {
    const headers = Object.entries(opts.headers || {})
      .map(([k, v]) => `${k}: ${v}`).join("\n");
    const r = await native.httpRequest({
      url,
      method: opts.method || "GET",
      headers,
      body: opts.body === undefined ? null
        : (typeof opts.body === "string" ? opts.body : toStr(opts.body)),
      timeoutMs: opts.timeoutMs || 60_000,
    });
    return { status: r.status, headers: {}, body: r.body };
  }
  return await curlShimFetch(url, opts);
}

// Body on stdout, then a trailing marker line carrying the status code.
async function curlShimFetch(url, opts = {}) {
  const args = ["curl", "-sS", "-L",
    "--max-time", String(Math.ceil((opts.timeoutMs || 60_000) / 1000))];
  if (opts.method && opts.method !== "GET") args.push("-X", opts.method);
  for (const [k, v] of Object.entries(opts.headers || {})) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-w", `\n${MARKER}%{http_code}`, url);

  const input = opts.body === undefined ? undefined
    : (typeof opts.body === "string" ? opts.body : toStr(opts.body));
  const out = await exec(input === undefined ? args : [...args, "--data-binary", "@-"],
    { input, timeoutMs: (opts.timeoutMs || 60_000) + 10_000 });

  if (out.status === 127) {
    throw new PlatformError("curl not found — pkg install curl");
  }
  const marker = out.stdout.lastIndexOf(`\n${MARKER}`);
  if (marker < 0) {
    throw new PlatformError(`curl failed: ${(out.stderr || out.stdout).slice(0, 200)}`);
  }
  const status = parseInt(out.stdout.slice(marker + 1 + MARKER.length), 10);
  return {
    status: Number.isNaN(status) ? 0 : status,
    headers: {},
    body: out.stdout.slice(0, marker),
  };
}

// ---- TCP: native socket module first, std.connectTCP second ------------------
async function tcpConnect(host, port) {
  if (native?.connectTcp) {
    const fd = native.connectTcp(String(host), port);
    let buf = "";
    return {
      async write(data) { if (native.socketWrite(fd, toStr(data)) === null) throw new PlatformError("tcp write fail"); },
      async readLine() {
        for (;;) {
          const idx = buf.indexOf("\n");
          if (idx >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            return line;
          }
          const chunk = native.socketRead(fd, 8192);
          if (chunk === null || chunk === undefined) return ""; // EOF
          buf += chunk;
        }
      },
      async close() { native.socketClose(fd); },
    };
  }
  if (typeof std.connectTCP !== "function") {
    throw new PlatformError(
      "qjs: no TCP (build native module via src/native/build.sh, or socat bridge)");
  }
  const fd = await std.connectTCP(String(host), port);
  let buf = "";
  return {
    async write(data) { os.write(fd, toStr(data)); },
    async readLine() {
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          return line;
        }
        const chunk = os.read(fd, 4096);
        if (!chunk || chunk.length === 0) return "";      // EOF
        buf += toStr(chunk);
      }
    },
    async close() { os.close(fd); },
  };
}

// ---- process via std.popen ----------------------------------------------------
// ng's popen object is a file handle with no wait(); exit codes are
// delivered via a temp file written by the wrapper shell after the group
// finishes, then read+cleaned up by us.
async function exec(cmd, opts = {}) {
  const shellCmd = Array.isArray(cmd) ? cmd.map(shellQuote).join(" ") : cmd;
  const t0 = Date.now();

  // stdin: temp file + redirect (popen gives us no stdin side)
  let redirect = "";
  let tmpFile = null;
  if (opts.input !== undefined && opts.input !== null) {
    tmpFile = `${TMPDIR}/anclaw-in-${Date.now()}-${tmpSeq++}.tmp`;
    fsWriteSync(tmpFile, toStr(opts.input));
    redirect = ` < ${shellQuote(tmpFile)}`;
  }

  const codeFile = `${TMPDIR}/anclaw-code-${Date.now()}-${tmpSeq++}.tmp`;
  const wrapped =
    `{ ${shellCmd}${redirect} ; } ; echo $? > ${shellQuote(codeFile)}`;

  const p = std.popen(`/bin/sh -c ${shellQuote(wrapped)}`, "r");
  let out = "";
  let cancelled = false;
  for (;;) {
    // ng: read(arrayBuffer) -> byte count; the old string read() is gone
    const buf = new ArrayBuffer(65536);
    let n;
    try { n = p.read(buf); } catch { break; }
    if (n === null || n === undefined || n <= 0) break;
    out += toStr(new Uint8Array(buf, 0, n));
    if (opts.timeoutMs && Date.now() - t0 > opts.timeoutMs) {
      // best-effort: stop reading; child may linger (see header comment)
      cancelled = true;
      out += "\n[anclaw: exec timeout, output truncated]\n";
      break;
    }
  }
  p.close();

  let code = -1;
  const codeTxt = await fsRead(codeFile).catch(() => null);
  if (codeTxt !== null && codeTxt !== undefined) code = parseInt(codeTxt.trim(), 10);
  if (Number.isNaN(code)) code = -1;
  if (typeof os.unlink === "function") { try { os.unlink(codeFile); } catch {} }
  else { std.popen(`rm -f ${shellQuote(codeFile)}`, "r").close(); }
  if (tmpFile) {
    if (typeof os.unlink === "function") { try { os.unlink(tmpFile); } catch {} }
    else { std.popen(`rm -f ${shellQuote(tmpFile)}`, "r").close(); }
  }
  return { status: cancelled ? -2 : code, stdout: out, stderr: "" };
}

// ---- fs -----------------------------------------------------------------------
function fsWriteSync(path, data) {
  const f = std.open(path, "w");
  if (!f) throw new PlatformError(`fsWrite: cannot open ${path}`);
  f.puts(data);
  f.close();
}

async function fsRead(path) {
  try {
    const s = std.loadFile(path);
    return s === null || s === undefined ? null : s;
  } catch { return null; }
}

async function fsWrite(path, data, append = false) {
  mkdirp(dirname(path));
  const f = std.open(path, append ? "a" : "w");
  if (!f) throw new PlatformError(`fsWrite: cannot open ${path}`);
  f.puts(data);
  f.close();
}

async function fsStat(path) {
  try {
    const st = os.stat(path);
    return { exists: true, size: st.st_size, isDir: (st.st_mode & 0o170000) === 0o040000 };
  } catch { return { exists: false, size: 0, isDir: false }; }
}

async function fsList(cwd) {
  const out = [];
  for (const name of os.readdir(cwd)) {
    if (name === "." || name === "..") continue;
    try {
      const st = os.stat(cwd + "/" + name);
      out.push((st && (st.st_mode & 0o170000) === 0o040000) ? name + "/" : name);
    } catch { out.push(name); }
  }
  return out;
}

async function fsMkdir(path) { mkdirp(path); }
async function fsUnlink(path) {
  if (typeof os.unlink === "function") {
    try { os.unlink(path); } catch (e) { throw new PlatformError(`fsUnlink: ${path}`); }
  } else {
    await exec(`rm -f ${shellQuote(path)}`, { timeoutMs: 5000 });
  }
}

// ---- time ----------------------------------------------------------------
// quickjs-ng exposes os.setTimeout when built with timers. Core only needs
// two things: a short keepalive timer (IRC PING) and retry backoff. Both
// tolerate big-timeout-granularity, so we use whatever ng gives us,
// else fail fast with a clear message.
function timeCheck() {
  if (typeof os.setTimeout !== "function") {
    throw new PlatformError(
      "qjs: timers need a quickjs-ng build with os.setTimeout");
  }
}
const time = {
  setTimeout: (fn, ms) => { timeCheck(); return os.setTimeout(fn, ms); },
  clearTimeout: (id) => { timeCheck(); if (typeof os.clearTimeout === "function") os.clearTimeout(id); },
};

// ---- io ----------------------------------------------------------------------
const stdin = {
  buf: "",
  done: false,
};
async function ioReadLine() {
  if (stdin.done) return null;
  const buf = new ArrayBuffer(4096);
  for (;;) {
    const idx = stdin.buf.indexOf("\n");
    if (idx >= 0) {
      const line = stdin.buf.slice(0, idx);
      stdin.buf = stdin.buf.slice(idx + 1);
      return line;
    }
    let n;
    try { n = std.in.read(buf); }
    catch { stdin.done = true; return stdin.buf || null; }
    if (n === null || n === undefined || n <= 0) {
      stdin.done = true;
      return stdin.buf || null;                       // EOF (partial line flushed)
    }
    stdin.buf += toStr(new Uint8Array(buf, 0, n));
  }
}
async function ioWrite(s) { std.out.puts(s); std.out.flush(); }

// ---- export -------------------------------------------------------------------
export default {
  name: "qjs",
  homeDir: (typeof std.getenv === "function" && std.getenv("HOME"))
    || os.getenv?.("HOME") || "",
  httpFetch,
  tcpConnect,
  exec,
  fsRead,
  fsWrite,
  fsStat,
  fsList,
  fsMkdir,
  fsUnlink,
  time,
  sha256: null,   // codex PKCE login needs it; qjs lacks crypto — copy auth.json from a node session
  io: { readLine: ioReadLine, write: ioWrite },
};

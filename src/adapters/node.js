// node adapter — full-fidelity implementation of the platform contract.
"use strict";

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as fsPath from "node:path";
import readline from "node:readline";
import { PlatformError } from "../platform.js";

async function httpFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body === undefined ? undefined
        : (typeof opts.body === "string" ? opts.body : opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs || 60_000),
    });
    const outHeaders = {};
    for (const [k, v] of res.headers) outHeaders[k.toLowerCase()] = v;
    return {
      status: res.status,
      headers: outHeaders,
      body: await res.text(),
    };
  } catch (e) {
    if (e && e.name === "TimeoutError")
      throw new PlatformError(`http timeout: ${url}`);
    throw new PlatformError(`http error: ${url}: ${e.message}`);
  }
}

function tcpConnect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = "";
    let closed = false;
    sock.setEncoding("utf8");
    sock.on("data", (d) => { buf += d; });
    sock.on("connect", () => {
      resolve({
        async write(data) {
          if (closed) throw new PlatformError("socket closed");
          sock.write(data);
        },
        async readLine() {
          while (true) {
            const idx = buf.indexOf("\n");
            if (idx >= 0) {
              const line = buf.slice(0, idx).replace(/\r$/, "");
              buf = buf.slice(idx + 1);
              return line;
            }
            if (closed) return "";
            await new Promise((r) => sock.once("data", r));
          }
        },
        async close() {
          closed = true;
          sock.end();
        },
      });
    });
    sock.on("error", (e) => {
      if (!sock._connected) reject(new PlatformError(`tcp error: ${e.message}`));
    });
  });
}

function exec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = opts.shell === false
      ? spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd })
      : spawn("/bin/sh", ["-c", Array.isArray(cmd) ? cmd.join(" ") : cmd],
          { cwd: opts.cwd });
    let out = "", err = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new PlatformError(`exec error: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code ?? -1, stdout: out, stderr: err });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

const io = {
  async readLine() {
    const rl = readline.createInterface({ input: process.stdin });
    const line = await new Promise((res) =>
      rl.question("", (l) => { rl.close(); res(l); }));
    return line;
  },
  async write(s) { process.stdout.write(s); },
};

export default {
  name: "node",
  homeDir: homedir(),
  httpFetch,
  tcpConnect,
  exec,
  async fsRead(path) {
    try { return await fsp.readFile(path, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  },
  async fsWrite(path, data, append = false) {
    if (append) await fsp.appendFile(path, data);
    else {
      await fsp.mkdir(fsPath.dirname(path), { recursive: true });
      await fsp.writeFile(path, data);
    }
  },
  async fsStat(path) {
    try {
      const st = await fsp.stat(path);
      return { exists: true, size: st.size, isDir: st.isDirectory() };
    } catch { return { exists: false, size: 0, isDir: false }; }
  },
  async fsList(cwd) {
    const dirents = await fsp.readdir(cwd, { withFileTypes: true });
    return dirents.map((d) => (d.isDirectory() ? d.name + "/" : d.name));
  },
  async fsMkdir(path) { await fsp.mkdir(path, { recursive: true }); },
  async fsUnlink(path) { await fsp.unlink(path); },
  time: {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  },
  io,
  // node-only extras (not part of the contract):
  tls: true,
};

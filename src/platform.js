// platform.js — the single I/O contract for anclaw.
//
// Everything below this file (core, channels, tools) imports `platform`
// and NOTHING else that touches the host environment. Two adapters
// implement it:
//
//   src/adapters/node.js  — Node >= 18 (fetch, node:net, child_process)
//   src/adapters/qjs.js   — quickjs-ng (curl subprocess for HTTPS,
//                           std sockets for plain TCP, os module for fs)
//
// If you add I/O, extend this contract first. No `fetch`, `console.*`
// escaping, `require()` or `import("node:*")` outside adapters.

"use strict";

export class PlatformError extends Error {}

/**
 * @typedef {Object} Platform
 * @property {(url: string, opts?: {method?: string, headers?: Record<string,string>, body?: string|Uint8Array, timeoutMs?: number}) => Promise<{status: number, headers: Record<string,string>, body: string}>} httpFetch
 * @property {(host: string, port: number) => Promise<NetSocket>} tcpConnect
 * @property {(cmd: string, opts?: {cwd?: string, input?: string, timeoutMs?: number, shell?: boolean}) => Promise<{status: number, stdout: string, stderr: string}>} exec
 * @property {(path: string) => Promise<string>} fsRead        // utf-8
 * @property {(path: string, data: string, append?: boolean) => Promise<void>} fsWrite
 * @property {(path: string) => Promise<{exists: boolean, size: number, isDir: boolean}>} fsStat
 * @property {(cwd: string) => Promise<string[]>} fsList       // returns entry names (files+dirs)
 * @property {(path: string) => Promise<void>} fsMkdir         // recursive
 * @property {(path: string) => Promise<void>} fsUnlink
 * @property {Promise<ArrayBuffer|Uint8Array>} sha256(text: string)  (optional; needed for codex PKCE login)
 * @property {{setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void}} time
 * @property {StreamIO} io                                     // stdin/stdout lines (CLI)
 * @property {string} name                                     // "node" | "qjs"
 * @property {string} homeDir                                  // $HOME
 */

/**
 * @typedef {Object} NetSocket
 * @property {(data: string) => Promise<void>} write
 * @property {() => Promise<string>} readLine                  // resolves "" on EOF
 * @property {() => Promise<void>} close
 * Wire protocol: only \n-delimited text is supported (enough for IRC).
 */

/**
 * @typedef {Object} StreamIO
 * @property {() => Promise<string|null>} readLine             // null = EOF
 * @property {(s: string) => Promise<void>} write
 */

let platform = null;

export async function loadPlatform() {
  if (platform) return platform;
  // Node first: decides by checking for node-ish globals, not by URL sniffing.
  const isNode =
    typeof process !== "undefined" &&
    process.versions && process.versions.node;
  if (isNode) {
    platform = (await import("./adapters/node.js")).default;
  } else {
    // quickjs-ng: dynamic import of the qjs adapter (it pulls in 'std').
    platform = (await import("./adapters/qjs.js")).default;
  }
  return platform;
}

export function setPlatform(p) { platform = p; }

export function getPlatform() {
  if (!platform) throw new PlatformError("platform.load() not called yet");
  return platform;
}

export async function platformReady() {
  await loadPlatform();
  return platform;
}

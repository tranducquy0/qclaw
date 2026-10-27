// bench.js — adapter comparison: HTTPS latency (and boot cost via runner).
// Run:  qjs --std -m src/bench.js   |   node src/bench.js
"use strict";

import { loadPlatform } from "./platform.js";

const URL_SMALL = "https://example.com/";          // tiny TLS + payload
const REPS = 5;
const WARMUP = 1;

function stats(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  const sum = ms.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    med: sorted[Math.floor(sorted.length / 2)],
    mean: Math.round(sum / ms.length),
  };
}

// RSS: node via memoryUsage, qjs via /proc/self/status (procfs readable).
async function rssMB(P) {
  if (P.name === "node") return globalThis.process.memoryUsage().rss / 1024 / 1024;
  let text = null;
  try { text = await P.fsRead("/proc/self/status"); } catch {}
  if (!text) {
    const r = await P.exec("cat /proc/self/status", { timeoutMs: 2000 }).catch(() => null);
    text = r?.stdout;
  }
  const m = text && text.match(/VmRSS:\s+(\d+) kB/);
  return m ? parseInt(m[1], 10) / 1024 : 0;
}

async function main() {
  const P = await loadPlatform();
  console.log(`bench target=${P.name} reps=${REPS} url=${URL_SMALL}`);
  console.log("(note: cross-network variance swamps thin deltas — compare runs)");

  const times = [];
  for (let i = 0; i < WARMUP + REPS; i++) {
    const t0 = Date.now();
    const r = await P.httpFetch(URL_SMALL, { timeoutMs: 15000 });
    const dt = Date.now() - t0;
    if (r.status !== 200) {
      console.log(`  req ${i}: status=${r.status} dt=${dt} (skipped)`);
      continue;
    }
    if (i >= WARMUP) {
      times.push(dt);
      const rss = i === WARMUP ? await rssMB(P) : null;
      console.log(`  req ${i}: ${dt}ms  ${r.body.length}b${rss ? ` rss=${rss.toFixed(1)}MB` : ""}`);
    }
  }

  if (times.length) {
    const s = stats(times);
    console.log(`summary: min=${s.min}ms med=${s.med}ms mean=${s.mean}ms`);
  }
}

try { await main(); } catch (e) {
  console.error(`bench: ${e?.message ?? e}`);
  if (globalThis.process) process.exitCode = 1;
}

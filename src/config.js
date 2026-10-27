// config.js — TOML-subset reader. Zero deps (works on Node AND qjs).
//
// Supported subset (enough for anclaw's config):
//   [section] and [section.sub]       -> nested objects
//   key = value                       -> string | int | float | bool
//   key = ["a", 1]                    -> single-line arrays
//   # comments and inline comments
//   quoted strings with \n \t \\ \" escapes
//
// NOT supported: multiline strings, inline tables, dotted bare keys.
// If a config needs those, it doesn't belong in this repo. Keep it flat.

"use strict";

const BARE = /^[A-Za-z0-9_-]+$/;

export class ConfigError extends Error {}

export function parseToml(text, file = "config") {
  const root = {};
  let section = root;

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const lineNo = `${file}:${n + 1}`;
    let line = lines[n];

    // strip comment (outside quotes), then trim
    const ci = indexOfComment(line);
    if (ci >= 0) line = line.slice(0, ci);
    line = line.trim();
    if (line === "") continue;

    // [section.sub] header
    if (line.startsWith("[")) {
      if (!line.endsWith("]"))
        throw new ConfigError(`${lineNo}: unmatched [ in table header`);
      section = root;
      for (const part of line.slice(1, -1).trim().split(".")) {
        const p = part.trim();
        const name = p.startsWith('"') && p.endsWith('"')
          ? p.slice(1, -1) : p;
        if (!p.startsWith('"') && !BARE.test(name)) {
          throw new ConfigError(`${lineNo}: bad table name '${p}'`);
        }
        if (typeof section[name] !== "object" || section[name] === null) {
          if (name in section)
            throw new ConfigError(`${lineNo}: '${name}' is both table and value`);
          section[name] = {};
        }
        section = section[name];
      }
      continue;
    }

    // key = value
    const eq = line.indexOf("=");
    if (eq < 0) throw new ConfigError(`${lineNo}: expected key = value`);
    const keyRaw = line.slice(0, eq).trim();
    const key = keyRaw.startsWith('"') && keyRaw.endsWith('"')
      ? keyRaw.slice(1, -1)
      : keyRaw;
    if (key === "" || (!keyRaw.startsWith('"') && !BARE.test(key))) {
      throw new ConfigError(`${lineNo}: bad key '${keyRaw}'`);
    }

    const valueTxt = line.slice(eq + 1).trim();
    if (valueTxt === "")
      throw new ConfigError(`${lineNo}: empty value for '${key}'`);

    section[key] = parseValue(valueTxt, lineNo);
  }
  return root;
}

// index of # outside quotes, or -1
function indexOfComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") { i++; continue; }          // skip escaped char
    if (c === '"') inStr = !inStr;
    else if (c === "#" && !inStr) return i;
  }
  return -1;
}

function parseValue(v, lineNo) {
  if (v.startsWith('"')) return parseString(v, lineNo);
  if (v.startsWith("[")) return parseArray(v, lineNo);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?(\d+)?\.\d+$/.test(v)) return parseFloat(v);
  throw new ConfigError(
    `${lineNo}: unsupported value '${v}' (strings need quotes; numbers, bools, arrays ok)`);
}

function parseString(v, lineNo) {
  // v starts with '"'; value may not extend past end of input
  let out = "";
  for (let i = 1; i < v.length; i++) {
    const c = v[i];
    if (c === "\\") {
      const e = v[++i];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === '"') out += '"';
      else if (e === "\\") out += "\\";
      else out += e;              // permissive: unknown escape = literal char
      continue;
    }
    if (c === '"') {
      const rest = v.slice(i + 1).trim();
      if (rest !== "") throw new ConfigError(`${lineNo}: junk after string '${rest}'`);
      return out;
    }
    out += c;
  }
  throw new ConfigError(`${lineNo}: unterminated string`);
}

function parseArray(v, lineNo) {
  if (!v.startsWith("[")) throw new ConfigError(`${lineNo}: bad array`);
  if (!v.endsWith("]")) throw new ConfigError(`${lineNo}: unterminated array`);
  const body = v.slice(1, -1);

  // split on top-level commas, respecting quoted strings
  const items = [];
  let cur = "", inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr && c === "\\") { cur += c + (body[i + 1] ?? ""); i++; continue; }
    if (c === '"') inStr = !inStr;
    if (c === "," && !inStr) { items.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "") items.push(cur);

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const t = items[i].trim();
    if (t === "") {
      if (items.length > 1 && i === items.length - 1) continue; // trailing comma ok
      throw new ConfigError(`${lineNo}: empty array element`);
    }
    out.push(parseValue(t, lineNo));
  }
  return out;
}

// ---- defaults + validation ---------------------------------------------------
export const DEFAULTS = {
  llm: {
    provider: "openai",          // "openai" | "codex"
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    style: "caveman",
    budgetTokens: 8000,
    maxTurns: 12,
    timeoutMs: 120000,
  },
  cli: { enable: true },
  telegram: { enable: false },
  irc: { enable: false },
  tools: {
    root: "~/.anclaw/workspace", // path jail for read/write
    maxOutput: 4000,             // chars of tool output fed back to LLM
    webFetchMax: 20000,
    exaKey: "",                  // for web action=search
  },
};

export function applyDefaults(cfg) {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    cfg[k] = { ...v, ...(cfg[k] || {}) };
  }
  return cfg;
}

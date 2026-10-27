// registry.js — tool definitions and dispatch.
// Every tool: { name, desc, args (JSON schema), run(input, ctx) -> string,
//               channelAllow: [names], danger: bool }
"use strict";

export class ToolError extends Error {}

export class Registry {
  constructor() { this.tools = new Map(); }

  register(t) {
    if (!t.name || typeof t.run !== "function")
      throw new ToolError("tool needs name+run");
    this.tools.set(t.name, t);
  }

  get(name) { return this.tools.get(name); }

  // allowed: per-channel predicate function(tool) -> bool
  list(allowed) {
    const out = [];
    for (const t of this.tools.values())
      if (!allowed || allowed(t)) out.push(t);
    return out;
  }
}

// Truncate tool output for the LLM: head+tail keeps both the start (errors,
// banner) and end (total counts, final line) of long outputs.
export function clipToolOutput(out, max) {
  if (out.length <= max) return out;
  const head = Math.floor(max * 0.55);
  const tail = max - head - 24;
  return out.slice(0, head) +
    `\n[... ${out.length - max} chars cut ...]\n` +
    out.slice(out.length - tail);
}

export async function dispatch(registry, name, argsJson, ctx) {
  const t = registry.get(name);
  if (!t) return `error: unknown tool '${name}'`;
  if (ctx.allowed && !ctx.allowed(t))
    return `error: tool '${name}' not allowed on this channel`;
  let input;
  try { input = typeof argsJson === "string" ? JSON.parse(argsJson || "{}") : argsJson; }
  catch (e) { return `error: bad tool arguments: ${e.message}`; }
  try {
    const out = await t.run(input, ctx);
    return clipToolOutput(
      typeof out === "string" ? out : JSON.stringify(out, null, 1),
      ctx.maxOutput || 4000);
  } catch (e) {
    return `error: ${e.message}`;
  }
}

export default Registry;

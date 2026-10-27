// runtime.js — the agent loop.
// One call at a time per session; tools via registry; budget via packContext.
"use strict";

import { packContext } from "./core/budget.js";
import { buildPrompt, toolSchemas } from "./core/prompt.js";
import { dispatch } from "./tools/registry.js";

export class Runtime {
  constructor({ client, registry, opts }) {
    this.client = client;
    this.registry = registry;
    this.opts = {
      budget: 8000,
      maxTurns: 12,             // loop iterations per user message
      channel: "cli",
      cwd: "~",
      domain: "",
      style: "caveman",
      maxOutput: 4000,
      allowed: null,            // (tool)=>bool for the channel
      ...opts,
    };
    // per-session serialization: one loop at a time per session id
    this.queues = new Map();
  }

  _serialize(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(key, next);
    return next;
  }

  async handle(session, userMsg) {
    return this._serialize(session.id, () => this._loop(session, userMsg));
  }

  async _loop(session, userMsg) {
    const o = this.opts;
    const toolNames = this.registry.list(o.allowed).map((t) => t.name);
    const sysPrompt = buildPrompt({
      style: o.style, channel: o.channel, domain: o.domain,
      toolNames, cwd: o.cwd, budget: o.budget,
    });
    const schemas = toolSchemas(this.registry, o.allowed);
    const ctx = {
      allowed: o.allowed,
      maxOutput: o.maxOutput,
      cwd: o.cwd,
      session,
      platform: this.client.platform,
    };

    const msgs = packContext(session, userMsg, sysPrompt, o.budget);

    let final = "";
    const turnMessages = [];              // this turn's assistant+tool msgs
    for (let i = 0; i < o.maxTurns; i++) {
      const res = await this.client.chat(msgs, schemas);
      const step = [];
      if (res.toolCalls.length) {
        step.push({
          role: "assistant",
          content: res.content ?? "",
          tool_calls: res.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        for (const tc of res.toolCalls) {
          const out = await dispatch(this.registry, tc.name, tc.arguments, ctx);
          step.push({ role: "tool", tool_call_id: tc.id, content: out });
        }
      } else {
        step.push({ role: "assistant", content: res.content ?? "" });
      }
      msgs.push(...step);
      turnMessages.push(...step);
      if (!res.toolCalls.length) { final = res.content ?? ""; break; }
      if (i === o.maxTurns - 1) {
        final = "[hit turn cap mid-task; last state above]";
      }
    }
    session.push(userMsg, turnMessages, final);
    return final;
  }
}

export default Runtime;

// prompt.js — system prompt builder. Caveman mode = terse imperative;
// saves ~1k tokens/turn on a 4k budget without degrading tool use.
"use strict";

const BASE_TOOLS = `
You are anclaw. Task agent.

Rules:
- You have tools. Use them. Do not labor long talk first.
- One way forward. Act, look at result, act again.
- shell = commands. read/write = files. search = rg code. web = search/fetch.
- Never narrate tool output. Not "I ran". Just act, then answer short.
- If blocked, say why in one line. No apology.
- Final answer: 1-6 lines. Code first if asked a code thing.
`;

const CHANNELS = {
  telegram: `
Channel: Telegram. Short answers. Markdown degrades\nbadly — plain text, no tables.`,
  irc: `
Channel: IRC. Very short (<=3 lines). No markdown. One topic per message.`,
  cli: `
Channel: CLI. Medium answers. Code blocks fine.`,
};

export function buildPrompt({ style = "caveman", domain, channel, toolNames, cwd, budget }) {
  let p = BASE_TOOLS;

  p += `
Context:
- cwd: ${cwd}
- tools: ${toolNames.join(", ")}
- budget: ${budget} tokens context. Assume share enough. Implies compact outputs.
`;

  if (domain) p += `Domain: ${domain}\n`;

  p += (CHANNELS[channel] || CHANNELS.cli);
  return p.trim() + "\n";
}

// Tool schema list builder (keeps JSON.ci payloads compact)
export function toolSchemas(registry, allowed) {
  return registry.list(allowed).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.desc,
      parameters: t.args || { type: "object", properties: {} },
    },
  }));
}

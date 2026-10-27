// core.js — built-in tools. All paths are jailed to `root` (read/write/web
// unaffected by jail for web; shell is jailed via cwd only).
"use strict";

import { PlatformError } from "../platform.js";

function resolve(root, p, home) {
  let path = (p || ".").replace(/^~\/?/, home.startsWith("/")
    ? home + "/" : "");
  if (path.startsWith("/")) return path;
  return (root.endsWith("/") ? root : root + "/") + path;
}

function outOfJail(root, path) {
  const r = root.endsWith("/") ? root : root + "/";
  return !path.startsWith(r);
}

export function registerCoreTools({ reg, P, root, maxOutput, webFetchMax, exaKey }) {
  const home = P.homeDir;
  const rootAbs = root.replace(/^~\/?/, home + "/");

  reg.register({
    name: "shell",
    desc: "Run a shell command (bash) inside the workspace root. " +
      "Output is captured (stdout+stderr mixed, clipped).",
    args: {
      type: "object",
      properties: { cmd: { type: "string", description: "the command" } },
      required: ["cmd"],
    },
    run: async (input, ctx) => {
      if (!input.cmd || typeof input.cmd !== "string")
        throw new PlatformError("shell: cmd required");
      // cd into root so relative paths work; respect output clip
      const r = await P.exec(input.cmd, {
        cwd: ctx.cwd === "~" ? rootAbs : ctx.cwd,
        timeoutMs: 60_000,
      });
      const body = (r.stdout + (r.stderr ? "\n[stderr] " + r.stderr : "")).trim();
      return `exit=${r.status}` + (body ? "\n" + body : " (no output)");
    },
  });

  reg.register({
    name: "read",
    desc: "Read a file (utf-8). Optional offset (1-based line) and limit.",
    args: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
    channelAllow: true,
    run: async (input) => {
      const path = resolve(rootAbs, input.path, home);
      if (outOfJail(rootAbs, path))
        throw new PlatformError(`read: outside workspace (${path})`);
      const text = await P.fsRead(path);
      if (text === null) throw new PlatformError(`read: no such file ${input.path}`);
      let lines = text.split("\n");
      if (input.offset) lines = lines.slice(input.offset - 1);
      if (input.limit) lines = lines.slice(0, input.limit);
      return lines.map((l, i) =>
        `${String((input.offset || 1) + i).padEnd(5)} ${l}`).join("\n");
    },
  });

  reg.register({
    name: "write",
    desc: "Write a file (utf-8). Whole-file by default; append=true appends.",
    args: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        append: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    run: async (input) => {
      const path = resolve(rootAbs, input.path, home);
      if (outOfJail(rootAbs, path))
        throw new PlatformError(`write: outside workspace (${path})`);
      await P.fsWrite(path, input.content ?? "", !!input.append);
      return `wrote ${input.path}`;
    },
  });

  reg.register({
    name: "search",
    desc: "rg-native code/text search, grep fallback. Regex ok. " +
      "ripgrep (rg) preferred if present on the system.",
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "regex or literal pattern" },
        globs: { type: "string", description: "optional glob like *.js" },
      },
      required: ["query"],
    },
    run: async (input) => {
      const probe = await P.exec(`command -v rg`, { timeoutMs: 4000 });
      const isRg = probe.status === 0;
      const cmd = isRg
        ? ["rg", "-n", "--no-heading", "--max-count=200", input.query,
            ...(input.globs ? ["-g", input.globs] : []), "."]
        : ["grep", "-rn", "-E", input.query, ".",
            ...(input.globs ? ["--include", input.globs] : [])];
      const r = await P.exec(cmd, { cwd: rootAbs, timeoutMs: 20_000 });
      const out = r.stdout.trim();
      if (!out) return `no matches (via ${isRg ? "rg" : "grep"})`;
      return out.length > maxOutput
        ? out.slice(0, maxOutput) + `\n... (${out.length} total)`
        : out;
    },
  });

  reg.register({
    name: "web",
    desc: "Web parent tool: `action` selects the sub-tool. " +
      "action=search → Exa web search (needs exa key in config.tools.exaKey). " +
      "action=fetch → raw HTML-stripped text of a URL.",
    args: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "fetch"] },
        query: { type: "string", description: "for action=search" },
        url: { type: "string", description: "for action=fetch" },
      },
      required: ["action"],
    },
    run: async (input, ctx) => {
      if (input.action === "fetch") return await webFetch(input, ctx);
      if (input.action === "search") return await webSearch(input, { ...ctx, exaKey });
      throw new PlatformError(`web: unknown action '${input.action}'`);
    },
  });

  // ---- sub-impls -------------------------------------------------------------
  async function webFetch(input) {
    if (!input.url) throw new PlatformError("web fetch: url required");
    if (!/^https?:\/\//.test(input.url))
      throw new PlatformError("web fetch: http(s) only");
    const res = await P.httpFetch(input.url, { timeoutMs: 30_000 });
    let txt = res.body;
    txt = txt
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (txt.length > webFetchMax) txt = txt.slice(0, webFetchMax) + " …[cut]";
    return res.status + " " + txt;
  }

  async function webSearch(input, ctx) {
    const exaKey = ctx.exaKey || "";
    if (!exaKey) throw new PlatformError("web search: tools.exaKey not set");
    const res = await P.httpFetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": exaKey },
      body: JSON.stringify({
        query: input.query,
        type: "neural",
        numResults: 5,
        contents: { text: { maxCharacters: 500 } },
      }),
      timeoutMs: 30_000,
    });
    if (res.status !== 200) return `exa error ${res.status}: ${res.body.slice(0, 200)}`;
    const j = JSON.parse(res.body);
    return (j.results || []).map((r) =>
      `- ${r.title}\n  ${r.url}\n  ${((r.text || "").replace(/\s+/g, " ").slice(0, 300))}`
    ).join("\n");
  }
}

export default registerCoreTools;

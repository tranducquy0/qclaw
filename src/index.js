import { loadPlatform } from "./platform.js";
import { parseToml, applyDefaults, ConfigError } from "./config.js";
import { CliChannel } from "./channels/cli.js";

function expandTilde(p, home) {
  if (!p) return p;
  return p.startsWith("~/") ? home + p.slice(1) : p;
}

async function loadConfig(P) {
  const path = expandTilde("~/.anclaw/config.toml", P.homeDir);
  const text = await P.fsRead(path);
  if (text === null) return { cfg: null, path };
  return { cfg: applyDefaults(parseToml(text, path)), path };
}

async function selfCheck(P, cfg, cfgPath) {
  const out = [];
  out.push(`anclaw v0.0.1  [platform: ${P.name}]`);
  out.push(`home:     ${P.homeDir}`);
  out.push(`config:   ${cfgPath}${cfg ? "" : "  (MISSING — will use defaults)"}`);

  // binary availability — decides search rg/grep fallback in phase 4
  for (const bin of ["rg", "grep", "curl"]) {
    const probe = await P.exec(
      `command -v ${bin}`, { timeoutMs: 3000 }
    ).catch(() => ({ status: -1, stdout: "", stderr: "" }));
    out.push(`bin:      ${bin.padEnd(6)} ${probe.status === 0 ? "found" : "MISSING"}`);
  }

  if (cfg) {
    const l = cfg.llm;
    out.push(`llm:      provider=${l.provider} model=${l.model} budget=${l.budgetTokens}t turns<=${l.maxTurns}`);
    for (const ch of ["cli", "telegram", "irc"]) {
      const c = cfg[ch] || {};
      const on = ch === "cli" ? (c.enable !== false) : c.enable === true;
      out.push(`channel:  ${ch.padEnd(9)} ${on ? "enabled" : "off"}`);
    }
  }
  return out.join("\n");
}

export async function main() {
  const P = await loadPlatform();
  const { cfg, path } = await loadConfig(P);
  console.log(await selfCheck(P, cfg, path));
  const runtime = await buildRuntime(P, cfg, path);

  if (cfg.cli.enable) {
    await new CliChannel({ P, runtime }).run();
  }
}

// ---- assembly --------------------------------------------------------------
async function buildRuntime(P, cfg, cfgPath) {
  const toolsRoot = expandTilde(cfg.tools.root, P.homeDir);
  const { Registry } = await import("./tools/registry.js");
  const { registerCoreTools } = await import("./tools/core.js");
  const { LLMClient } = await import("./llm/client.js");
  const { Runtime } = await import("./runtime.js");

  const registry = new Registry();
  registerCoreTools({
    reg: registry,
    P,
    root: toolsRoot,
    maxOutput: cfg.tools.maxOutput,
    webFetchMax: cfg.tools.webFetchMax,
    exaKey: cfg.tools.exaKey,
    cfgPath,
  });

  const authPath = expandTilde("~/.anclaw/auth.json", P.homeDir);
  const llm = new LLMClient({
    provider: cfg.llm.provider,
    baseURL: cfg.llm.baseURL,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    authPath,
  }, {
    http: P.httpFetch,
    io: P.io,
    fs: { read: P.fsRead, write: P.fsWrite },
    sha256: P.sha256 || undefined,
  });

  return new Runtime({
    client: llm,
    registry,
    opts: {
      budget: cfg.llm.budgetTokens,
      maxTurns: cfg.llm.maxTurns,
      channel: "cli",
      cwd: toolsRoot,
      style: cfg.llm.style,
      maxOutput: cfg.tools.maxOutput,
      allowed: null,
    },
  });
}

// ---- assembly --------------------------------------------------------------

try {
  await main();
} catch (e) {
  const tag = (e instanceof ConfigError) ? "" : `${e?.name || "Error"}: `;
  console.error(`anclaw: ${tag}${e?.message ?? String(e)}`);
  if (e?.stack && globalThis.process?.env?.ANCLAW_DEBUG) console.error(e.stack);
  if (globalThis.process) process.exitCode = 1;
  else if (typeof std?.exit === "function") std.exit(1);
}

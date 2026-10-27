// client.js — LLM chat client (OpenAI-compatible + Codex).
// No deps; runs on node (fetch) and qjs (platform.httpFetch).
"use strict";

// ---- token store (auth.json) -------------------------------------------------
// shape: { provider, apikey?, access_token?, refresh_token?, expires_at? }

export class LLMAuthError extends Error {}
export class LLMError extends Error {
  constructor(message, status, body) {
    super(`llm: ${message}`);
    void body; void status;
  }
}

export class LLMClient {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;                    // {provider, baseURL, apiKey, model}
    this.authPath = cfg.authPath;      // resolved by caller
    this.http = opts.http;             // injected fetch/httpFetch impl
    this.io = opts.io;                 // for interactive login prompt
    this.fs = opts.fs;                 // {read, write}
    this.log = opts.log || (() => {});
    this.sha256Impl = opts.sha256 || (async () => {
      throw new LLMAuthError(
        "sha256 unavailable on this platform — log in once with the node " +
        "adapter and copy ~/.anclaw/auth.json");
    });
  }

  // ---- auth ----------------------------------------------------------------
  async loadAuth() {
    if (this._auth) return this._auth;
    let text = null;
    try { text = await this.fs.read(this.authPath); } catch { text = null; }
    this._auth = text ? JSON.parse(text) : {};
    return this._auth;
  }

  async saveAuth() {
    await this.fs.write(this.authPath, JSON.stringify(this._auth, null, 2) + "\n");
  }

  nowSec() { return Math.floor(Date.now() / 1000); }

  async accessToken() {
    const auth = await this.loadAuth();
    if (this.cfg.provider === "codex")
      return await this.codexToken(auth);
    if (!this.cfg.apiKey) throw new LLMAuthError("llm.apiKey missing in config");
    return this.cfg.apiKey;
  }

  async codexToken(auth) {
    // fresh access token?
    if (auth.access_token &&
        auth.expires_at && auth.expires_at - this.nowSec() > 300) {
      return auth.access_token;
    }
    // refresh flow
    if (auth.refresh_token && auth.client_id) {
      try {
        const res = await this.http({
          url: "https://auth.openai.com/oauth/token",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: auth.refresh_token,
            client_id: auth.client_id,
          }),
          timeoutMs: 30_000,
        });
        if (res.status === 200) {
          const tok = JSON.parse(res.body);
          auth.access_token = tok.access_token;
          auth.expires_at = this.nowSec() + (tok.expires_in || 3600);
          await this.saveAuth();
          return auth.access_token;
        }
        this.log(`codex refresh failed (${res.status}) — falling back to re-login`);
      } catch (e) {
        this.log(`codex refresh error: ${e.message}`);
      }
    }
    return await this.interactiveLogin(auth);
  }

  // Manual-loopback login (portable: also works on qjs where we can't open
  // a listener): print auth URL, user pastes the redirected callback URL.
  async interactiveLogin(auth) {
    if (!this.io) throw new LLMAuthError("codex login needed but no cli io");
    // PKCE
    const verifier = this.randomB64(48);
    const challenge = this.base64Url(await this.sha256(verifier));
    const clientId = auth.client_id || "app_EMoamEEZ73f0CkXnXqVrbbfMG"; // Codex CLI client
    const redirectUri = "http://localhost:1455/auth/callback";
    const url =
      "https://auth.openai.com/authorize?" +
      "response_type=code" +
      `&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent("openid profile email offline_access")}` +
      "&state=anclaw" +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    this.io.write("\ncodex login: open this URL, sign in, then paste the\n" +
      "URL at the end (starts with http://localhost:1455/...):\n\n" +
      `  ${url}\n\n> `);
    const pasted = (await this.io.readLine()).trim();
    const m = /[?&]code=([^&\s]+)/.exec(pasted);
    if (!m) throw new LLMAuthError("no code in pasted URL");
    const res = await this.http({
      url: "https://auth.openai.com/oauth/token",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: m[1],
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
      timeoutMs: 30_000,
    });
    if (res.status !== 200) {
      throw new LLMAuthError(`token exchange failed: ${res.status}`);
    }
    const tok = JSON.parse(res.body);
    this._auth = {
      ...auth,
      client_id: clientId,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: this.nowSec() + (tok.expires_in || 3600),
    };
    await this.saveAuth();
    return this._auth.access_token;
  }

  base64Url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  randomB64(n) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    return this.base64Url(a);
  }

  async sha256(text) {
    const arr = (await this.sha256Impl(text));   // Uint8Array from platform
    return arr instanceof ArrayBuffer ? new Uint8Array(arr) : arr;
  }

  // ---- chat --------------------------------------------------------------
  // messages: [{role, content}]; tools: [{type:"function", function:{...}}]
  // returns: { content, toolCalls: [{ id, name, arguments }] }
  async chat(messages, tools) {
    const token = await this.accessToken();
    const body = {
      model: this.cfg.model,
      messages,
      parallel_tool_calls: false,
    };
    if (tools && tools.length) body.tools = tools;
    const res = await this.http({
      url: `${this.cfg.baseURL}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      timeoutMs: this.cfg.timeoutMs || 120_000,
    });
    if (res.status === 401) throw new LLMAuthError("auth rejected (401)");
    if (res.status >= 400) {
      throw new LLMError(`chat failed: ${res.status} ${
        (res.body || "").slice(0, 300)}`);
    }
    const j = JSON.parse(res.body);
    const msg = j.choices && j.choices[0] && j.choices[0].message || {};
    return {
      content: msg.content ?? "",
      toolCalls: (msg.tool_calls || []).map((tc) => ({
        id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
      })),
      usage: j.usage,
    };
  }
}

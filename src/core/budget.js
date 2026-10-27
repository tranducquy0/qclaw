// budget.js — token estimate, context packing, session turn store.
// No tokenizer dependency: heuristic char/4 count is enough for a budget
// we control (errors of ±10% acceptable; cap enforced empirically).
"use strict";

export function estimateTokens(text) {
  if (text === undefined || text === null) return 0;
  if (typeof text !== "string") {
    if (Array.isArray(text))                     // content blocks
      return text.reduce((a, p) => a + estimateTokens(
        typeof p === "string" ? p : p.text || JSON.stringify(p)), 0);
    return estimateTokens(JSON.stringify(text));
  }
  // heuristic: ~4 chars/token for EN/CJK mix, +10% for punctuation-wise JSON
  return Math.ceil(text.length / 3.8);
}

export function toolResultTokens(tr) {
  return estimateTokens(typeof tr === "string" ? tr : JSON.stringify(tr));
}

// Session turn: { user, assistant: [{...toolstep messages}], reply }
export function turnTokens(turn) {
  return estimateTokens(turn.user) + estimateTokens(turn.messages);
}

export class Session {
  constructor(id) {
    this.id = id;
    this.turns = [];          // [{user, messages, reply}]; messages = assistant msgs for the context
    this.summary = "";        // one-liner compaction of old turns
    this.turnCount = 0;
  }

  push(user, messages, reply) {
    this.turns.push({ user, messages, reply });
    this.turnCount++;
  }
}

export function serializeSession(s) {
  return JSON.stringify({
    id: s.id, turns: s.turns, summary: s.summary, turnCount: s.turnCount,
  });
}

export function parseSession(text) {
  if (!text) return null;
  const o = JSON.parse(text);
  const s = new Session(o.id);
  s.turns = o.turns || [];
  s.summary = o.summary || "";
  s.turnCount = o.turnCount || 0;
  return s;
}

// ---- packing -----------------------------------------------------------------
// Build the final `messages` array under a token budget:
//   1. system prompt (with caveman style injected by prompt.js)
//   2. running summary of collapsed turns
//   3. recent turns verbatim (newest-grabble, keep whole turns atomically)
//   4. the new user message
export const PACK = {
  minKeepRecent: 1,         // never drop the just-sent turn
  summarizeTag: "TURN",
};

export function packContext(session, userMsg, sysPrompt, budget, opts = {}) {
  void PACK;
  // newest -> oldest, keep whole turns while they fit; older turns roll up
  const kept = [];
  let used = estimateTokens(sysPrompt) + estimateTokens(userMsg) +
    estimateTokens(session.summary) + 300;    // fixed overhead headroom

  for (let i = session.turns.length - 1; i >= 0; i--) {
    const turn = session.turns[i];
    const t = turnTokens(turn);
    if (used + t > budget && (kept.length >= opts.minKeepRecent || opts.hardStop)) {
      turn.dropCount = (turn.dropCount || 0) + 1;
      continue;
    }
    used += t;
    kept.unshift(turn);
  }
  const dropped = session.turns.filter((t) => !kept.includes(t));

  // summarize dropped turns into the rollup
  if (dropped.length) {
    session.summary =
      (session.summary ? session.summary + "\n" : "") +
      dropped.map((t) =>
        `${PACK.summarizeTag}: ${clip(t.user, 80)}` +
        (t.reply ? ` -> ${clip(t.reply, 120)}` : "")).join("\n");
  }
  if (dropped.length) {
    // mark dropped turns compact-or-dropped: strip their message arrays to
    // the single (collapsed) placeholder to keep serialized JSON small.
    for (const t of dropped) {
      t.messages = [{ role: "user", content: "[folded]" }];
      t.reply = "";
    }
  }

  // keep summary itself bounded
  let lines = session.summary.split("\n");
  if (lines.length > 40) {
    lines = lines.slice(-40);
    session.summary = lines.join("\n");
  }

  const msgs = [{ role: "system", content: sysPrompt }];
  if (session.summary.trim()) {
    msgs.push({ role: "user", content:
      `[log of earlier turns, folded]\n${session.summary}` });
  }
  for (const turn of kept) {
    const folded = turn.messages.length === 1 &&
      turn.messages[0].content === "[folded]";
    if (folded) continue;                 // summary already carries this turn
    msgs.push(...turn.messages, { role: "assistant", content: turn.reply });
  }
  msgs.push({ role: "user", content: userMsg });
  return msgs;
}

function clip(s, n) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

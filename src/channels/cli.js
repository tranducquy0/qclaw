// cli.js — CLI channel: prompt days are numbered.
// stdin line -> runtime.handle(session, line) -> print reply.
"use strict";

import { Session, serializeSession, parseSession } from "../core/budget.js";

const SESSION_FILE = "~/.anclaw/sessions/cli.json";

export class CliChannel {
  constructor({ P, runtime }) {
    this.P = P;
    this.runtime = runtime;
    this.eof = false;
  }

  async run() {
    const path = this.resolve(SESSION_FILE);
    const saved = await this.P.fsRead(path);
    this.session = parseSession(saved) || new Session("cli");
    console.log("anclaw cli — empty line quits, /reset clears session");

    while (!this.eof) {
      this.P.io.write("» ");
      const line = await this.P.io.readLine();
      if (line === null || line === "") break;
      if (line === "/reset") { this.session = new Session("cli"); continue; }
      if (line === "/quit") break;
      if (line === "/help") { continue; }
      let reply;
      try {
        reply = await this.runtime.handle(this.session, line);
      } catch (e) {
        console.log(`error: ${e.message}`);
        continue;
      }
      console.log(reply);
    }
    try { await this.P.fsWrite(path, serializeSession(this.session)); }
    catch (e) { void e; }
  }

  resolve(p) {
    return p.replace(/^~/, this.P.homeDir);
  }
}

export default CliChannel;

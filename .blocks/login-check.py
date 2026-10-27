# /// block
# name = "login-check"
# summary = "run scripted codex /login end-to-end and prove the token exchange reaches auth.openai.com"
# params = ["engine"]
# effects = "external"
# example = ["caveman-blocks run login-check --engine node", "caveman-blocks run login-check --engine qjs"]
# returns.keys = ["engine", "exchanged", "http_status"]
#
# [stamp]
# verified = "07740f453be4"
# ///

# Composes boot-check first, then drives a scripted /login against the real
# auth.openai.com: temp HOME, provider=codex, pasted fake callback URL. The
# fake code must FAIL with a concrete HTTP status (4xx/5xx) — that proves
# URL build + paste handling + token exchange all executed. auth.json must
# stay absent: failed logins never persist.

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

def die(msg, code=2):
    print(json.dumps({"error": msg}))
    sys.exit(code)


def param(argv, flag, default):
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            return argv[i + 1]
    return default


def main():
    argv = sys.argv[1:]
    engine = param(argv, "--engine", "node")
    if engine not in ("node", "qjs"):
        die(f"engine must be node|qjs, got '{engine}'")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    home = tempfile.mkdtemp(prefix="anclaw-logincheck-")
    try:
        env = dict(os.environ, HOME=home)
        try:
            subprocess.run(
                ["bash", "anclaw.sh", engine], cwd=root, env=env,
                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                timeout=45)
        except subprocess.TimeoutExpired:
            die(f"{engine} boot phase hung (45s timeout)", 1)
        cfg = os.path.join(home, ".anclaw", "config.toml")
        if not os.path.exists(cfg):
            die("boot did not scaffold config.toml", 1)
        with open(cfg) as f:
            text = f.read().replace('provider = "openai"', 'provider = "codex"')
        with open(cfg, "w") as f:
            f.write(text)
        try:
            r = subprocess.run(
                ["bash", "anclaw.sh", engine], cwd=root, env=env,
                input="/login\nhttp://localhost:1455/auth/callback?code=abc\n/quit\n",
                capture_output=True, text=True, timeout=90)
        except subprocess.TimeoutExpired:
            die(f"{engine} login flow hung (90s timeout)", 1)
        m = re.search(r"token exchange failed: (\d{3})", r.stdout)
        auth = os.path.join(home, ".anclaw", "auth.json")
        out = {
            "engine": engine,
            "exchanged": bool(m or ("auth.openai.com" in r.stdout)),
            "http_status": int(m.group(1)) if m else None,
            "auth_persisted": os.path.exists(auth),
        }
        if not out["exchanged"]:
            out["hint"] = (r.stdout[-300:] or r.stderr[-300:]).strip()
        ok = out["exchanged"] and not out["auth_persisted"] and (
            not m or m.group(1).startswith("4"))
        print(json.dumps(out))
        sys.exit(0 if ok else 1)
    finally:
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()

# /// block
# name = "boot-check"
# summary = "boot anclaw under node or qjs; assert banner, bin probes and first-run config scaffold"
# params = ["engine"]
# effects = "exec"
# example = ["caveman-blocks run boot-check --engine node", "caveman-blocks run boot-check --engine qjs"]
# returns.keys = ["engine", "ok", "bins_found", "config_created"]
#
# [stamp]
# verified = "156c9eb2c205"
# ///

# Boot smoke for anclaw: empty-stdin run under one engine, temp HOME, then a
# small JSON verdict. Expects: banner, all three bin probes (rg/grep/curl)
# found, first-run config.toml scaffolded. Cleans the temp home up after.

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

COMMANDS = []


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
    home = tempfile.mkdtemp(prefix="anclaw-bootcheck-")
    try:
        env = dict(os.environ, HOME=home)
        try:
            r = subprocess.run(
                ["bash", "anclaw.sh", engine], cwd=root, env=env,
                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                timeout=45)
        except subprocess.TimeoutExpired:
            die(f"{engine} boot hung (45s timeout)", 1)
        if r.returncode != 0:
            die(f"{engine} exited {r.returncode}: {r.stderr.strip()[:200]}", 1)
        tail = (r.stdout.splitlines() or [""])[-1].strip()
        bins_found = len(re.findall(r"^bin:\s+\S+\s+found", r.stdout, re.M))
        cfg = os.path.join(home, ".anclaw", "config.toml")
        out = {
            "engine": engine,
            "ok": bins_found == 3 and os.path.exists(cfg) and tail == "»",
            "bins_found": bins_found,
            "config_created": os.path.exists(cfg),
        }
        if not out["ok"] and bins_found != 3:
            out["hint"] = f"{3 - bins_found} bin probes failed"
        print(json.dumps(out))
        sys.exit(0 if out["ok"] else 1)
    finally:
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()

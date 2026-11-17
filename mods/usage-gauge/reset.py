# Uses one free "Full reset" pass of a Codex account (the one that expires first), through that
# account's app-server, as the Codex app does. The pass is spent for good: the usage-gauge mod
# only runs this after the person confirms.
#   python -X utf8 reset.py <account> [--dry-run]   (--dry-run lists the passes, spends nothing)
# Prints {"outcome": "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed", ...} as JSON.
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid

if len(sys.argv) < 2:
    sys.exit("usage: reset.py <account> [--dry-run]")
name = sys.argv[1]
dry = "--dry-run" in sys.argv[2:]
base = os.path.expanduser("~")


def account_home(account):
    if account == "codex":
        return os.environ.get("CODEX_HOME") or os.path.join(base, ".codex")
    pattern = os.path.join(base, ".local", "bin", "codex*.cmd" if os.name == "nt" else "codex*")
    for wrapper in sorted(glob.glob(pattern)):
        wrapper_name = re.sub(r"\.cmd$", "", os.path.basename(wrapper), flags=re.I)
        if wrapper_name != account or (os.name != "nt" and not os.access(wrapper, os.X_OK)):
            continue
        try:
            if os.path.getsize(wrapper) > 256_000:
                continue
            with open(wrapper, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        match = re.search(r'^\s*(?:export\s+)?CODEX_HOME\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s#;&]+))', text, re.M | re.I)
        if not match:
            match = re.search(r'^\s*@?(?:set\s+)?"?CODEX_HOME=([^"\r\n]+)', text, re.M | re.I)
        if match:
            raw = next((value for value in match.groups() if value is not None), "").strip()
            raw = raw.replace("%USERPROFILE%", base).replace("%HOME%", base)
            return os.path.normpath(os.path.expanduser(os.path.expandvars(raw)))
    # Compatibility with the original Windows account layout.
    return os.path.join(base, ".local", "share", "codex-accounts", account)


home = account_home(name)
if not os.path.isdir(home):
    sys.exit(f"no Codex account folder for {name}")

if os.name == "nt":
    exes = sorted(glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe")), key=os.path.getmtime, reverse=True)
    executable = exes[0] if exes else None
else:
    executable = shutil.which("codex")
if not executable:
    sys.exit("Codex executable not found.")
proc = subprocess.Popen([executable, "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, encoding="utf-8", env={**os.environ, "CODEX_HOME": home},
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
watchdog = threading.Timer(60, proc.kill)
watchdog.daemon = True
watchdog.start()


def send(msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()


def answer(want):
    for line in proc.stdout:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("id") == want:
            if "error" in msg:
                raise RuntimeError(msg["error"].get("message", "app-server error"))
            return msg["result"]
    sys.exit("app-server didn't answer.")


def available():
    """The available passes, soonest to expire first. The usage read sometimes fails at Codex's
    end and comes back without the list, so ask again before calling it empty."""
    for attempt in range(3):
        send({"id": 10 + attempt, "method": "account/rateLimits/read"})
        try:
            credits = answer(10 + attempt).get("rateLimitResetCredits")
        except RuntimeError:
            continue
        if credits is not None and (credits.get("credits") is not None or credits.get("availableCount") == 0):
            passes = [c for c in credits.get("credits") or [] if c.get("status") == "available"]
            return sorted(passes, key=lambda c: c.get("expiresAt") or float("inf"))
    sys.exit("Couldn't get the reset pass list from Codex. Try again in a moment.")


try:
    send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "herdr-usage", "version": "0.1"}}})
    answer(1)
    send({"method": "initialized"})
    passes = available()
    if dry or not passes:
        out = {"outcome": "dryRun" if dry and passes else "noCredit",
               "passes": [{"id": c["id"], "title": c.get("title"), "expiresAt": c.get("expiresAt")} for c in passes]}
    else:
        send({"id": 20, "method": "account/rateLimitResetCredit/consume",
              "params": {"creditId": passes[0]["id"], "idempotencyKey": str(uuid.uuid4())}})
        out = {"outcome": answer(20)["outcome"], "used": passes[0]["id"], "left": len(passes) - 1}
except RuntimeError as e:
    sys.exit(str(e))
finally:
    proc.kill()
sys.stdout.write(json.dumps(out, ensure_ascii=False))

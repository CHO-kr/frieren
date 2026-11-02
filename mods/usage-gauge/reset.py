# Uses one free "Full reset" pass of a Codex account (the one that expires first), through that
# account's app-server, as the Codex app does. The pass is spent for good: the usage-gauge mod
# only runs this after the person confirms.
#   python -X utf8 reset.py <account> [--dry-run]   (--dry-run lists the passes, spends nothing)
# Prints {"outcome": "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed", ...} as JSON.
import glob
import json
import os
import subprocess
import sys
import threading
import uuid

name = sys.argv[1]
dry = "--dry-run" in sys.argv[2:]
home = os.path.expanduser(r"~\.codex") if name == "codex" else os.path.join(os.path.expanduser(r"~\.local\share\codex-accounts"), name)
if not os.path.isdir(home):
    sys.exit(f"no Codex account folder for {name}")

exes = sorted(glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe")), key=os.path.getmtime, reverse=True)
if not exes:
    sys.exit("codex.exe not found under %LOCALAPPDATA%\\OpenAI\\Codex\\bin")
proc = subprocess.Popen([exes[0], "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
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
    sys.exit("app-server가 답하지 않았어요.")


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
    sys.exit("Codex에서 초기화권 목록을 받지 못했어요. 잠시 뒤 다시 해 보세요.")


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

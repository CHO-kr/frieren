# Reads plan usage (5-hour and weekly windows) for every Claude and Codex account on this PC and
# prints it as JSON for the usage-gauge mod.
#   Claude: the endpoint Claude Code's /usage reads, with each account's own login. The token is
#           sent only to Anthropic and never printed or stored; it is never refreshed here.
#   Codex:  each account's app-server (account/rateLimits/read), as the Codex app asks it.
# A failed read keeps the last good numbers, marked stale.
import base64
import concurrent.futures
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")


def data_store():
    if os.environ.get("HERDR_SESSIONS_DIR"):
        return os.environ["HERDR_SESSIONS_DIR"]
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA", HOME), "herdr-sessions")
    if sys.platform == "darwin":
        return os.path.join(HOME, "Library", "Caches", "herdr-sessions")
    return os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(HOME, ".local", "share")), "herdr-sessions")


CACHE = os.path.join(data_store(), "usage.json")


def ms(value):
    """Epoch milliseconds from an ISO time or epoch seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value * 1000 if value < 10**12 else value)
    return int(datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def wrapper_accounts(prefix, variable):
    pattern = os.path.join(HOME, ".local", "bin", prefix + ("*.cmd" if os.name == "nt" else "*"))
    found = []
    for wrapper in sorted(glob.glob(pattern)):
        if os.name != "nt" and not os.access(wrapper, os.X_OK):
            continue
        try:
            if os.path.getsize(wrapper) > 256_000:
                continue
            with open(wrapper, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        match = re.search(r'^\s*(?:export\s+)?' + re.escape(variable) + r'\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s#;&]+))', text, re.M | re.I)
        if not match:
            match = re.search(r'^\s*@?(?:set\s+)?"?' + re.escape(variable) + r'=([^"\r\n]+)', text, re.M | re.I)
        if not match:
            continue
        raw = next((value for value in match.groups() if value is not None), "").strip()
        raw = raw.replace("%USERPROFILE%", HOME).replace("%HOME%", HOME)
        folder = os.path.normpath(os.path.expanduser(os.path.expandvars(raw)))
        if not os.path.isdir(folder):
            continue
        name = re.sub(r"\.cmd$", "", os.path.basename(wrapper), flags=re.I)
        found.append((name, folder))
    return found


def claude_accounts():
    folder = os.path.join(HOME, ".claude")
    found = [("claude", folder, os.path.join(HOME, ".claude.json"))]
    seen = {os.path.normcase(os.path.realpath(folder))}
    for name, folder in wrapper_accounts("claude", "CLAUDE_CONFIG_DIR"):
        key = os.path.normcase(os.path.realpath(folder))
        if key not in seen:
            found.append((name, folder, os.path.join(folder, ".claude.json")))
            seen.add(key)
    return found


def claude_oauth(name, folder):
    """OAuth record from the portable file or the account's macOS Keychain item."""
    try:
        return read_json(os.path.join(folder, ".credentials.json"))["claudeAiOauth"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    if sys.platform != "darwin":
        raise RuntimeError("Claude credentials were not found.")
    plain = "Claude Code-credentials"
    services = [plain] if name == "claude" else [plain + "-" + hashlib.sha256(folder.encode()).hexdigest()[:8], plain]
    for service in services:
        try:
            result = subprocess.run(["security", "find-generic-password", "-s", service, "-w"], stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True, encoding="utf-8", timeout=10)
            if result.returncode == 0:
                return json.loads(result.stdout)["claudeAiOauth"]
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            pass
    # Never include keychain output or credential content in this error.
    raise RuntimeError("Claude credentials were not found in the config directory or macOS Keychain.")


class Wait(RuntimeError):
    """The server asked to come back later (429 with Retry-After)."""

    def __init__(self, message, seconds):
        super().__init__(message)
        self.seconds = seconds


def claude_login(name, token, recorded):
    """Which account a login really is (the profile record can lag behind a /login elsewhere).
    Asked once per token, not every reading."""
    fp = hashlib.sha256(token.encode()).hexdigest()[:16]
    last = previous.get(("claude", name)) or {}
    login = last.get("login") if last.get("token_fp") == fp else None
    if not login:
        try:
            req = urllib.request.Request("https://api.anthropic.com/api/oauth/profile",
                                         headers={"Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20"})
            with urllib.request.urlopen(req, timeout=15) as r:
                login = (json.load(r).get("account") or {}).get("email")
        except (urllib.error.URLError, ValueError):
            pass
    warning = f"Actually logged in as {login} (the profile says {recorded})." if login and recorded and login != recorded else None
    return {"token_fp": fp, "login": login, "warning": warning}


def claude_usage(name, folder, profile):
    out = {"agent": "claude", "name": name, "email": None}
    try:
        out["email"] = read_json(profile).get("oauthAccount", {}).get("emailAddress")
    except (OSError, ValueError):
        pass
    oauth = claude_oauth(name, folder)
    out.update(claude_login(name, oauth["accessToken"], out["email"]))
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage",
                                 headers={"Authorization": "Bearer " + oauth["accessToken"], "anthropic-beta": "oauth-2025-04-20"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            # Claude Code's own sessions read this endpoint too; asking again before the
            # server's Retry-After only keeps the account limited longer.
            seconds = int(e.headers.get("retry-after") or 600)
            raise Wait(f"Usage reads for this account are rate-limited. Reading again in {round(seconds / 60)} min.", seconds)
        raise RuntimeError({401: "Login expired. Open Claude Code once with this account to renew it."}.get(e.code, f"HTTP {e.code}"))
    windows = [("5h", data.get("five_hour")), ("weekly", data.get("seven_day"))]
    out["windows"] = [{"label": label, "used": round(w["utilization"]), "resets": ms(w.get("resets_at"))}
                      for label, w in windows if w and w.get("utilization") is not None]
    return out


def span(minutes):
    """A window's name from its length: Codex plans differ (5 hours and a week, or a week, or 30 days)."""
    if not minutes:
        return "limit"
    if minutes <= 6 * 60:
        return f"{round(minutes / 60)}h"
    if minutes <= 8 * 24 * 60:
        return "weekly"
    return f"{round(minutes / 1440)}d"


def codex_exe():
    if os.name == "nt":
        exes = sorted(glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe")), key=os.path.getmtime, reverse=True)
        executable = exes[0] if exes else None
    else:
        executable = shutil.which("codex")
    if not executable:
        raise RuntimeError("Codex executable not found.")
    return executable


def codex_accounts():
    main = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    found = [("codex", main)]
    seen = {os.path.normcase(os.path.realpath(main))}
    for name, folder in wrapper_accounts("codex", "CODEX_HOME"):
        key = os.path.normcase(os.path.realpath(folder))
        if key not in seen:
            found.append((name, folder))
            seen.add(key)
    if os.name == "nt":
        others = os.path.join(HOME, ".local", "share", "codex-accounts")
        for name in sorted(os.listdir(others)) if os.path.isdir(others) else []:
            folder = os.path.join(others, name)
            wrapper = os.path.join(HOME, ".local", "bin", name + ".cmd")
            key = os.path.normcase(os.path.realpath(folder))
            if os.path.isfile(wrapper) and key not in seen:
                found.append((name, folder))
                seen.add(key)
    return found


def codex_usage(name, home):
    out = {"agent": "codex", "name": name, "email": None}
    try:
        token = read_json(os.path.join(home, "auth.json"))["tokens"]["id_token"].split(".")[1]
        out["email"] = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))).get("email")
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        pass
    proc = subprocess.Popen([codex_exe(), "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, encoding="utf-8", env={**os.environ, "CODEX_HOME": home},
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    watchdog = threading.Timer(40, proc.kill)
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
        raise RuntimeError("app-server didn't answer.")

    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "herdr-usage", "version": "0.1"}}})
        answer(1)
        send({"method": "initialized"})
        send({"id": 2, "method": "account/rateLimits/read"})
        result = answer(2)
        limits = result["rateLimits"]
    finally:
        proc.kill()
    found = [w for w in (limits.get("primary"), limits.get("secondary")) if w]
    found.sort(key=lambda w: w.get("windowDurationMins") or 0)
    out["plan"] = limits.get("planType")
    # Credits left, and the free "Full reset" passes that clear the limit at once.
    credits = limits.get("credits") or {}
    try:
        balance = float(credits.get("balance")) if credits.get("balance") is not None else None
    except ValueError:
        balance = None
    out["credits"] = {"balance": balance, "unlimited": bool(credits.get("unlimited")), "has": bool(credits.get("hasCredits"))}
    passes = [c for c in ((result.get("rateLimitResetCredits") or {}).get("credits") or []) if c.get("status") == "available"]
    out["resets"] = {"count": (result.get("rateLimitResetCredits") or {}).get("availableCount", len(passes)),
                     "expires": min((ms(c["expiresAt"]) for c in passes if c.get("expiresAt")), default=None)}
    out["windows"] = [{"label": span(w.get("windowDurationMins")), "used": w.get("usedPercent"), "resets": ms(w.get("resetsAt"))} for w in found]
    return out


try:
    previous = {(a["agent"], a["name"]): a for a in read_json(CACHE)["accounts"]}
except (OSError, ValueError, KeyError):
    previous = {}

now = int(time.time() * 1000)


def waiting(agent, args):
    """The last row of an account the server told us to leave alone for now. A new Claude login
    is another account (or a fresh token), so it doesn't inherit the wait."""
    row = previous.get((agent, args[0]))
    if not row or (row.get("retry_at") or 0) <= now:
        return None
    if agent == "claude":
        try:
            token = claude_oauth(args[0], args[1])["accessToken"]
            if hashlib.sha256(token.encode()).hexdigest()[:16] != row.get("token_fp"):
                return None
        except (OSError, ValueError, KeyError, RuntimeError):
            pass
    return row


jobs = [(claude_usage, a) for a in claude_accounts()] + [(codex_usage, a) for a in codex_accounts()]
accounts = []
with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
    futures = [(fn, args, None if waiting("claude" if fn is claude_usage else "codex", args) else pool.submit(fn, *args))
               for fn, args in jobs]
    for fn, args, future in futures:
        agent = "claude" if fn is claude_usage else "codex"
        if future is None:
            row = dict(waiting(agent, args))
            row["error"] = f"Usage reads for this account are rate-limited. Reading again in {max(1, round((row['retry_at'] - now) / 60000))} min."
            if agent == "claude":
                # The login check is another endpoint, so it still runs while usage waits.
                try:
                    token = claude_oauth(args[0], args[1])["accessToken"]
                    row.update(claude_login(args[0], token, row.get("email")))
                except (OSError, ValueError, KeyError, RuntimeError):
                    pass
            accounts.append(row)
            continue
        try:
            row = future.result()
            row.update(checked=now, stale=False, error=None, retry_at=None, login_needed=None)
        except Exception as e:
            row = dict(previous.get((agent, args[0])) or {"agent": agent, "name": args[0], "windows": []})
            error = str(e) or type(e).__name__
            # Logged out (Codex: no auth.json, app-server says "authentication required";
            # Claude: 401). The chip says so instead of showing the last numbers as if current.
            login_needed = "authentication required" in error or error.startswith("Login expired")
            if login_needed and agent == "codex":
                error = f"Logged out, so usage can't be read. Run `{args[0]} login` in a terminal to log in again."
            row.update(stale=True, error=error, login_needed=login_needed or None,
                       retry_at=now + e.seconds * 1000 if isinstance(e, Wait) else None)
        accounts.append(row)

os.makedirs(os.path.dirname(CACHE), exist_ok=True)
with open(CACHE, "w", encoding="utf-8") as f:
    json.dump({"at": now, "accounts": accounts}, f, ensure_ascii=False)
print(json.dumps({"at": now, "accounts": accounts}, ensure_ascii=False))

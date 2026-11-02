"""Which account a hand-started agent runs on.

    python -X utf8 who.py <terminal address>

Herdr only knows a terminal's shell argv, so an agent typed into the shell ("claude2", "codex3")
leaves the pane header without an account. This finds the shell's claude.exe / codex.exe child
and reads, from that process, its command line and the variable that picks the account:
CLAUDE_CONFIG_DIR (claude2 = ~/.claude-2) or CODEX_HOME (codexN = ~/.local/share/codex-accounts/codexN).
Prints {"account", "agent", "model", "pid"} as JSON, or {"error"} with exit code 1.
Windows only; reads processes of the same user (no admin needed).
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import re
import subprocess
import sys

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")

TH32CS_SNAPPROCESS = 0x2
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class PROCESS_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Reserved1", ctypes.c_void_p), ("PebBaseAddress", ctypes.c_void_p),
        ("Reserved2", ctypes.c_void_p * 2), ("UniqueProcessId", ctypes.c_void_p), ("Reserved3", ctypes.c_void_p),
    ]


k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.OpenProcess.restype = wt.HANDLE
k32.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [wt.HANDLE]
ntdll.NtQueryInformationProcess.argtypes = [wt.HANDLE, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]


def processes():
    """{pid: (parent pid, exe name)} for every process now."""
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    out = {}
    e = PROCESSENTRY32W()
    e.dwSize = ctypes.sizeof(e)
    ok = k32.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        out[e.th32ProcessID] = (e.th32ParentProcessID, e.szExeFile.lower())
        ok = k32.Process32NextW(snap, ctypes.byref(e))
    k32.CloseHandle(snap)
    return out


def read(h, addr, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(got)):
        raise OSError(ctypes.get_last_error(), "ReadProcessMemory")
    return buf.raw[: got.value]


def ptr(h, addr):
    return int.from_bytes(read(h, addr, 8), "little")


def unicode_string(h, addr):
    length = int.from_bytes(read(h, addr, 2), "little")
    return read(h, ptr(h, addr + 8), length).decode("utf-16-le", "replace") if length else ""


def command_and_env(pid):
    """A 64-bit process's command line and environment, from its PEB."""
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        raise OSError(ctypes.get_last_error(), "OpenProcess")
    try:
        pbi = PROCESS_BASIC_INFORMATION()
        if ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), None) != 0:
            raise OSError("NtQueryInformationProcess")
        params = ptr(h, pbi.PebBaseAddress + 0x20)  # PEB.ProcessParameters
        cmd = unicode_string(h, params + 0x70)  # RTL_USER_PROCESS_PARAMETERS.CommandLine
        env_at = ptr(h, params + 0x80)  # .Environment
        env_size = int.from_bytes(read(h, params + 0x3F0, 8), "little")  # .EnvironmentSize
        raw = read(h, env_at, min(env_size or 65536, 1 << 20)).decode("utf-16-le", "replace")
        env = {}
        for item in raw.split("\0"):
            if not item:
                break
            k, sep, v = item.partition("=")
            if sep and k:
                env[k.upper()] = v
        return cmd, env
    finally:
        k32.CloseHandle(h)


def norm(path):
    return os.path.normcase(os.path.normpath(os.path.expandvars(path))) if path else ""


def account_for(agent, env, home):
    """The account name from the variable that picked it, else None."""
    if agent == "claude":
        cfg = norm(env.get("CLAUDE_CONFIG_DIR", ""))
        if not cfg or cfg == norm(os.path.join(home, ".claude")):
            return "claude"
        # Known accounts first (the session panel's list), then the ~/.claude-N convention.
        try:
            with open(os.path.join(home, ".config", "herdr-app", "shared.json"), encoding="utf-8") as f:
                for a in json.load(f).get("sessions.claude", {}).get("accounts", []):
                    if a.get("config") and norm(a["config"]) == cfg:
                        return a["name"]
        except Exception:
            pass
        m = re.search(r"\.claude-(\d+)$", cfg)
        return f"claude{m.group(1)}" if m else None
    cdx = norm(env.get("CODEX_HOME", ""))
    if not cdx or cdx == norm(os.path.join(home, ".codex")):
        return "codex"
    m = re.search(r"codex-accounts\\(codex\d*)$", cdx)
    return m.group(1) if m else None


def model_flag(cmd):
    words = [w.strip("'\"") for w in re.findall(r"'[^']*'|\"[^\"]*\"|\S+", cmd)]
    for i, w in enumerate(words[:-1]):
        if w in ("--model", "-m"):
            return words[i + 1]
        if w.startswith("--model="):
            return w.split("=", 1)[1]
    return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: who.py <terminal>"}))
        return 1
    home = os.path.expanduser("~")
    r = subprocess.run(["hc", "get", sys.argv[1], "--json"], capture_output=True, text=True, encoding="utf-8",
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        shell = int(json.loads(r.stdout)["pid"])
    except Exception:
        print(json.dumps({"error": f"no pid for {sys.argv[1]}"}))
        return 1

    procs = processes()
    kids = {}
    for pid, (ppid, _name) in procs.items():
        kids.setdefault(ppid, []).append(pid)
    # Breadth first under the shell: the nearest claude.exe / codex.exe (wrappers are cmd.exe in between).
    queue, seen, found = [(shell, 0)], set(), None
    while queue and not found:
        pid, depth = queue.pop(0)
        for c in sorted(kids.get(pid, [])):
            if c in seen:
                continue
            seen.add(c)
            name = procs[c][1]
            if name in ("claude.exe", "codex.exe"):
                found = (c, name[:-4])
                break
            if depth < 3 and name in ("cmd.exe", "powershell.exe", "pwsh.exe", "node.exe"):
                queue.append((c, depth + 1))
    if not found:
        print(json.dumps({"error": "no claude.exe / codex.exe under this shell"}))
        return 1

    pid, agent = found
    try:
        cmd, env = command_and_env(pid)
    except Exception as e:
        print(json.dumps({"error": f"could not read process {pid}: {e}"}))
        return 1
    account = account_for(agent, env, home)
    if not account:
        print(json.dumps({"error": "unknown account folder", "agent": agent, "pid": pid}))
        return 1
    print(json.dumps({"account": account, "agent": agent, "model": model_flag(cmd), "pid": pid}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Which account a hand-started Claude/Codex process runs with.

    python -X utf8 who.py <terminal address>

Prints {"account", "agent", "model", "pid"}, or {"error"}. Windows reads
the child process PEB as before; POSIX follows the shell's process tree with
ps and reads only CLAUDE_CONFIG_DIR/CODEX_HOME from the selected process.
"""

import json
import os
import re
import subprocess
import sys


WINDOWS = os.name == "nt"

if WINDOWS:
    import ctypes
    import ctypes.wintypes as wt

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
    """{pid: (parent pid, executable name, command)} for every process now."""
    if WINDOWS:
        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        out = {}
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            out[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower(), "")
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
        k32.CloseHandle(snap)
        return out
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,comm=,command="], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=8)
    out = {}
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) < 3:
            continue
        try:
            pid, ppid = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        out[pid] = (ppid, os.path.basename(fields[2]).lower(), fields[3] if len(fields) > 3 else fields[2])
    return out


if WINDOWS:
    def read(h, addr, size):
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t()
        if not k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(got)):
            raise OSError(ctypes.get_last_error(), "ReadProcessMemory")
        return buf.raw[:got.value]

    def ptr(h, addr):
        return int.from_bytes(read(h, addr, 8), "little")

    def unicode_string(h, addr):
        length = int.from_bytes(read(h, addr, 2), "little")
        return read(h, ptr(h, addr + 8), length).decode("utf-16-le", "replace") if length else ""


def command_and_env(pid, process=None):
    if WINDOWS:
        h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not h:
            raise OSError(ctypes.get_last_error(), "OpenProcess")
        try:
            pbi = PROCESS_BASIC_INFORMATION()
            if ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), None) != 0:
                raise OSError("NtQueryInformationProcess")
            params = ptr(h, pbi.PebBaseAddress + 0x20)
            cmd = unicode_string(h, params + 0x70)
            env_at = ptr(h, params + 0x80)
            env_size = int.from_bytes(read(h, params + 0x3F0, 8), "little")
            raw = read(h, env_at, min(env_size or 65536, 1 << 20)).decode("utf-16-le", "replace")
            env = {}
            for item in raw.split("\0"):
                if not item:
                    break
                key, sep, value = item.partition("=")
                if sep and key:
                    env[key.upper()] = value
            return cmd, env
        finally:
            k32.CloseHandle(h)

    command = process[2] if process else ""
    env = {}
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            values = f.read().decode("utf-8", "replace").split("\0")
        for item in values:
            key, sep, value = item.partition("=")
            if sep and key in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
                env[key] = value
    except OSError:
        result = subprocess.run(["ps", "eww", "-p", str(pid), "-o", "command="], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=8)
        raw = result.stdout.strip()
        for key in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
            match = re.search(r"(?:^|\s)" + key + r"=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)", raw)
            if match:
                env[key] = match.group(1)
    return command, env


def norm(path):
    if not path:
        return ""
    return os.path.normcase(os.path.realpath(os.path.normpath(os.path.expanduser(os.path.expandvars(path)))))


def shared_account(agent, folder, home):
    try:
        with open(os.path.join(home, ".config", "herdr-app", "shared.json"), encoding="utf-8") as f:
            accounts = json.load(f).get(f"sessions.{agent}", {}).get("accounts", [])
        for item in accounts:
            config = item.get("config") if agent == "claude" else item.get("home") or item.get("config")
            if config and norm(config) == folder:
                return item.get("name")
    except (OSError, ValueError, TypeError):
        pass
    return None


def wrapper_account(agent, folder, home):
    import glob
    pattern = os.path.join(home, ".local", "bin", agent + ("*.cmd" if WINDOWS else "*"))
    variable = "CLAUDE_CONFIG_DIR" if agent == "claude" else "CODEX_HOME"
    for path in sorted(glob.glob(pattern)):
        if not WINDOWS and not os.access(path, os.X_OK):
            continue
        try:
            if os.path.getsize(path) > 256_000:
                continue
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        match = re.search(r'^\s*(?:export\s+)?' + variable + r'\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s#;&]+))', text, re.M | re.I)
        if not match:
            match = re.search(r'^\s*@?(?:set\s+)?"?' + variable + r'=([^"\r\n]+)', text, re.M | re.I)
        if not match:
            continue
        raw = next((value for value in match.groups() if value is not None), "")
        raw = raw.replace("%USERPROFILE%", home).replace("%HOME%", home)
        if norm(raw) == folder:
            return re.sub(r"\.cmd$", "", os.path.basename(path), flags=re.I)
    return None


def account_for(agent, env, home):
    variable = "CLAUDE_CONFIG_DIR" if agent == "claude" else "CODEX_HOME"
    folder = norm(env.get(variable, ""))
    default = norm(os.path.join(home, ".claude" if agent == "claude" else ".codex"))
    if not folder or folder == default:
        return agent
    known = shared_account(agent, folder, home) or wrapper_account(agent, folder, home)
    if known:
        return known
    if agent == "claude":
        match = re.search(r"\.claude-(\d+)$", folder)
        return f"claude{match.group(1)}" if match else None
    match = re.search(r"(?:^|[\\/])codex-accounts[\\/](codex[^\\/]+)$", folder, re.I)
    return match.group(1) if match else None


def model_flag(command):
    words = [word.strip("'\"") for word in re.findall(r"'[^']*'|\"[^\"]*\"|\S+", command)]
    for index, word in enumerate(words):
        if word in ("--model", "-m") and index + 1 < len(words):
            return words[index + 1]
        if word.startswith("--model="):
            return word.split("=", 1)[1]
    return None


def agent_kind(name, command):
    base = re.sub(r"\.exe$", "", os.path.basename(name), flags=re.I)
    if base in ("claude", "codex"):
        return base
    words = [os.path.basename(word.strip("'\"")) for word in re.findall(r"'[^']*'|\"[^\"]*\"|\S+", command)]
    for word in words[:5]:
        match = re.match(r"^(claude|codex)(?:\d+|-[a-z0-9][a-z0-9_-]*)?(?:\.cmd|\.exe)?$", word, re.I)
        if match:
            return match.group(1).lower()
    return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: who.py <terminal>"}))
        return 1
    home = os.path.expanduser("~")
    result = subprocess.run(["hc", "get", sys.argv[1], "--json"], capture_output=True, text=True, encoding="utf-8",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        shell = int(json.loads(result.stdout)["pid"])
    except (ValueError, KeyError, TypeError):
        print(json.dumps({"error": f"no pid for {sys.argv[1]}"}))
        return 1

    try:
        procs = processes()
    except (OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": f"could not list processes: {error}"}))
        return 1
    children = {}
    for pid, (ppid, _name, _command) in procs.items():
        children.setdefault(ppid, []).append(pid)
    queue, seen, found = [(shell, 0)], set(), None
    while queue and not found:
        pid, depth = queue.pop(0)
        for child in sorted(children.get(pid, [])):
            if child in seen:
                continue
            seen.add(child)
            agent = agent_kind(procs[child][1], procs[child][2])
            if agent:
                found = (child, agent)
                break
            if depth < 6:
                queue.append((child, depth + 1))
    if not found:
        print(json.dumps({"error": "no claude / codex process under this shell"}))
        return 1

    pid, agent = found
    try:
        command, env = command_and_env(pid, procs.get(pid))
    except (OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": f"could not read process {pid}: {error}"}))
        return 1
    account = account_for(agent, env, home)
    if not account:
        print(json.dumps({"error": "unknown account folder", "agent": agent, "pid": pid}))
        return 1
    print(json.dumps({"account": account, "agent": agent, "model": model_flag(command), "pid": pid}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

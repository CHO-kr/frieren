# Recent result files under a folder for the results-panel mod, newest first, as JSON.
#   python -X utf8 recent.py <folder> [limit]      the list (images get thumbnails, videos posters)
#   python -X utf8 recent.py --files <file> ...    the same row facts for these files, in the given
#                                                  order; missing ones, folders and relative paths are
#                                                  left out ("dir" is the file's whole folder here)
#   python -X utf8 recent.py --preview <file>      a screen-sized copy of an image to show large
# Pictures are shown from the app's own folder (gpui's image() resolves there), so thumbnails,
# posters and previews are small copies in ~/.config/herdr-app/.thumbs (hidden: no mod reload).
# Each is written under a temporary name and moved into place, so two runs making the same
# picture at once never show a half-written file.
import hashlib
import heapq
import json
import os
import shutil
import subprocess
import sys
import time

APP = os.environ.get("HERDR_APP_HOME") or os.path.expanduser(r"~\.config\herdr-app")
THUMBS = os.path.join(APP, ".thumbs")
KINDS = {
    "image": {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"},
    "video": {"mp4", "mov", "webm", "mkv", "avi", "m4v"},
    "audio": {"mp3", "wav", "m4a", "ogg", "flac", "aac"},
    "doc": {"md", "pdf", "html", "htm", "txt", "docx", "pptx", "xlsx", "csv", "srt", "vtt", "json", "log"},
    "code": {"py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "ps1", "css", "sh", "bat", "cmd", "toml", "yaml", "yml", "xml"},
}
KIND = {ext: kind for kind, exts in KINDS.items() for ext in exts}
SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", ".cache", ".next", ".svelte-kit", "AppData", ".codex",
        ".claude", ".claude-2", ".npm", ".nuget", ".local", "$Recycle.Bin", "site-packages", ".gradle", ".idea", ".vscode",
        ".thumbs", "Microsoft", "OneDrive"}


def cached(path, variant, ext):
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_mtime_ns}|{st.st_size}|{variant}".encode()).hexdigest()[:20]
    return os.path.join(THUMBS, f"{key}.{ext}")


def relative(path):
    return os.path.relpath(path, APP).replace("\\", "/")


def temporary(out):
    """Where `out` is written first: same folder and extension, a name of this run's own."""
    return os.path.join(THUMBS, f"tmp-{os.getpid()}-{os.path.basename(out)}")


def settle(tmp, out):
    """Moves a finished picture into place (another run may have made the same one meanwhile)."""
    try:
        os.replace(tmp, out)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def picture(path, size):
    """A copy at most `size` px wide/high, made once (SVG is copied as is)."""
    os.makedirs(THUMBS, exist_ok=True)
    ext = path.rsplit(".", 1)[-1].lower()
    if ext == "svg":
        out = cached(path, "svg", "svg")
        if not os.path.exists(out):
            tmp = temporary(out)
            shutil.copyfile(path, tmp)
            settle(tmp, out)
        return relative(out)
    out = cached(path, size, "png" if ext in ("png", "gif", "webp") else "jpg")
    if not os.path.exists(out):
        from PIL import Image
        tmp = temporary(out)
        with Image.open(path) as im:
            im.thumbnail((size, size))
            if out.endswith(".jpg") and im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(tmp, "JPEG" if out.endswith(".jpg") else "PNG", quality=85)
        settle(tmp, out)
    return relative(out)


def poster(path):
    """A frame from about a second in, made once with ffmpeg."""
    os.makedirs(THUMBS, exist_ok=True)
    out = cached(path, "poster", "jpg")
    if not os.path.exists(out):
        tmp = temporary(out)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "1", "-i", path, "-frames:v", "1", "-vf", "scale=320:-2", tmp],
                       timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
        if os.path.exists(tmp):
            settle(tmp, out)
    return relative(out) if os.path.exists(out) else None


def prune():
    """Drops cached pictures nobody looked at for a week."""
    if not os.path.isdir(THUMBS):
        return
    old = time.time() - 7 * 86400
    for name in os.listdir(THUMBS):
        full = os.path.join(THUMBS, name)
        try:
            if os.path.getatime(full) < old:
                os.remove(full)
        except OSError:
            pass


PER_FOLDER = 6  # a render's frame folder can't push everything else off the list


def scan(folder, limit):
    """Newest files of known kinds. Folders are walked newest first (a new file touches its
    folder's time), so the 60k-entry / 2.5 s cap cuts old corners, not new results. The home
    folder goes 3 levels deep, others 8."""
    home = os.path.normcase(os.path.expanduser("~")) == os.path.normcase(folder)
    depth_max, started, seen, best = (3 if home else 8), time.time(), 0, []
    keep = limit * 4
    try:
        queue = [(-os.stat(folder).st_mtime, folder, 0)]
    except OSError:
        return [], 0, False
    truncated = False
    while queue:
        _, current, depth = heapq.heappop(queue)
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for e in entries:
            seen += 1
            if seen > 60000 or time.time() - started > 2.5:
                truncated, queue = True, []
                break
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.name not in SKIP and depth < depth_max:
                        heapq.heappush(queue, (-e.stat().st_mtime, e.path, depth + 1))
                    continue
                ext = e.name.rsplit(".", 1)[-1].lower() if "." in e.name else ""
                if ext not in KIND:
                    continue
                st = e.stat()
            except OSError:
                continue
            item = (st.st_mtime, e.path, st.st_size, ext)
            if len(best) < keep:
                heapq.heappush(best, item)
            elif item[0] > best[0][0]:
                heapq.heapreplace(best, item)
    files, per = [], {}
    for mtime, path, size, ext in sorted(best, reverse=True):
        parent = os.path.dirname(path)
        per[parent] = per.get(parent, 0) + 1
        if per[parent] > PER_FOLDER:
            continue
        if len(files) == limit:
            break
        files.append({"path": path, "name": os.path.basename(path), "dir": os.path.relpath(os.path.dirname(path), folder),
                      "kind": KIND[ext], "ext": ext, "size": size, "mtime": int(mtime * 1000)})
    return files, seen, truncated


def explicit(paths):
    """Row facts for named files (an agent's loot), in the given order. A kind this script doesn't
    know is "other"; the panel may take the caller's own word for it."""
    files = []
    for path in paths:
        if not os.path.isabs(path):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        if not os.path.isfile(path):
            continue
        name = os.path.basename(path)
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        files.append({"path": path, "name": name, "dir": os.path.dirname(path), "kind": KIND.get(ext, "other"),
                      "ext": ext, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
    return files


def thumbnails(files):
    """Small pictures for the first 40 images and posters for the first 10 videos."""
    images = videos = 0
    for f in files:
        try:
            if f["kind"] == "image" and images < 40:
                f["thumb"], images = picture(f["path"], 160), images + 1
            elif f["kind"] == "video" and videos < 10:
                f["thumb"], videos = poster(f["path"]), videos + 1
        except Exception:
            f["thumb"] = None


if __name__ == "__main__":
    if sys.argv[1] == "--preview":
        sys.stdout.write(json.dumps({"image": picture(sys.argv[2], 1800)}))
        sys.exit()
    if sys.argv[1] == "--files":
        files = explicit(sys.argv[2:])
        thumbnails(files)
        sys.stdout.write(json.dumps({"files": files}, ensure_ascii=False))
        sys.exit()
    folder, limit = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 80
    files, seen, truncated = scan(folder, limit)
    thumbnails(files)
    prune()
    sys.stdout.write(json.dumps({"folder": folder, "scanned": seen, "truncated": truncated, "files": files}, ensure_ascii=False))

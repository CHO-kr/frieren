"""Classify the clipboard and turn a lone bitmap into a copied PNG file.

    python -X utf8 clip.py [--check]

Prints text, files, image, or none.  --check never changes the clipboard.
"""

import datetime
import os
import subprocess
import sys
import time


HOME = os.path.expanduser("~")


def data_store():
    if os.environ.get("HERDR_SESSIONS_DIR"):
        return os.environ["HERDR_SESSIONS_DIR"]
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA", HOME), "herdr-sessions")
    if sys.platform == "darwin":
        return os.path.join(HOME, "Library", "Caches", "herdr-sessions")
    return os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(HOME, ".local", "share")), "herdr-sessions")


FOLDER = os.path.join(data_store(), "clipboard")


def mac_info():
    try:
        result = subprocess.run(["osascript", "-e", "clipboard info"], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=8)
        return result.stdout.lower() if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def mac_text():
    try:
        return subprocess.run(["pbpaste"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def mac_has_image():
    script = "try\nset imageData to the clipboard as «class PNGf»\nreturn true\non error\nreturn false\nend try"
    try:
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=8)
        return result.returncode == 0 and result.stdout.strip().lower() == "true"
    except (OSError, subprocess.SubprocessError):
        return False


def mac_copy_file(path):
    script = "on run argv\nset the clipboard to (POSIX file (item 1 of argv))\nend run"
    subprocess.run(["osascript", "-e", script, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=8, check=True)


def mac_save_clipboard(path):
    """Native fallback for Macs whose python3 has no Pillow."""
    script = """on run argv
set outFile to POSIX file (item 1 of argv)
set imageData to the clipboard as «class PNGf»
set fileRef to open for access outFile with write permission
try
  set eof fileRef to 0
  write imageData to fileRef
  close access fileRef
on error messageText number messageNumber
  try
    close access fileRef
  end try
  error messageText number messageNumber
end try
end run"""
    result = subprocess.run(["osascript", "-e", script, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
    return result.returncode == 0 and os.path.isfile(path) and os.path.getsize(path) > 0


def save_image(copy_file):
    os.makedirs(FOLDER, exist_ok=True)
    for name in os.listdir(FOLDER):
        full = os.path.join(FOLDER, name)
        try:
            if os.path.getmtime(full) < time.time() - 7 * 86400:
                os.remove(full)
        except OSError:
            pass
    path = os.path.join(FOLDER, datetime.datetime.now().strftime("screenshot-%Y%m%d-%H%M%S.png"))
    try:
        from PIL import ImageGrab
        picture = ImageGrab.grabclipboard()
        if picture is None or isinstance(picture, list):
            return False
        picture.save(path)
    except ImportError:
        if sys.platform != "darwin" or not mac_save_clipboard(path):
            return False
    copy_file(path)
    return True


def windows():
    import ctypes
    available = ctypes.windll.user32.IsClipboardFormatAvailable
    cf_text, cf_bitmap, cf_dib, cf_unicode, cf_hdrop, cf_dibv5 = 1, 2, 8, 13, 15, 17
    if available(cf_hdrop):
        return "files"
    if available(cf_unicode) or available(cf_text):
        return "text"
    if not (available(cf_dib) or available(cf_dibv5) or available(cf_bitmap)):
        return "none"
    if "--check" in sys.argv:
        return "image"

    def copy_file(path):
        subprocess.run(["powershell", "-NoProfile", "-Command", "& { param($p) Set-Clipboard -LiteralPath $p }", path],
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=True)
    return "image" if save_image(copy_file) else "none"


def macos():
    info = mac_info()
    if "class furl" in info or "public.file-url" in info or "file url" in info:
        return "files"
    if mac_text():
        return "text"
    image_hint = any(kind in info for kind in ("class pngf", "class tiff", "public.png", "public.tiff"))
    if "--check" in sys.argv:
        if image_hint or mac_has_image():
            return "image"
        try:
            from PIL import ImageGrab
            picture = ImageGrab.grabclipboard()
            return "image" if picture is not None and not isinstance(picture, list) else "none"
        except Exception:
            return "none"
    try:
        return "image" if save_image(mac_copy_file) else "none"
    except Exception:
        return "none"


def posix():
    # Text paste remains useful on Linux; image-to-file needs a desktop-specific
    # clipboard implementation and is intentionally left to Herdr there.
    for command in (["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"]):
        try:
            if subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8).returncode == 0:
                return "text"
        except (OSError, subprocess.SubprocessError):
            pass
    return "none"


print(windows() if os.name == "nt" else macos() if sys.platform == "darwin" else posix())

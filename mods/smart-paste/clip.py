# What a Ctrl+V should paste, for the smart-paste mod. Text and copied files Herdr pastes itself;
# an image alone on the clipboard (a screenshot) it can't on Windows, so this saves it as a PNG
# and puts that file on the clipboard instead, for Herdr to paste as a path (agents attach it).
#   python -X utf8 clip.py [--check]   prints "text", "files", "image" (saved, file on clipboard) or "none"
#                                      (--check only says what is there and changes nothing)
import ctypes
import datetime
import os
import subprocess
import sys
import time

CF_TEXT, CF_BITMAP, CF_DIB, CF_UNICODETEXT, CF_HDROP, CF_DIBV5 = 1, 2, 8, 13, 15, 17
FOLDER = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "herdr-sessions", "clipboard")

available = ctypes.windll.user32.IsClipboardFormatAvailable
if available(CF_HDROP):
    print("files")
elif available(CF_UNICODETEXT) or available(CF_TEXT):
    print("text")
elif not (available(CF_DIB) or available(CF_DIBV5) or available(CF_BITMAP)):
    print("none")
elif "--check" in sys.argv:
    print("image")
else:
    from PIL import ImageGrab
    picture = ImageGrab.grabclipboard()
    if picture is None or isinstance(picture, list):
        print("none")
        sys.exit()
    os.makedirs(FOLDER, exist_ok=True)
    # Screenshots kept for a week, then dropped.
    for name in os.listdir(FOLDER):
        full = os.path.join(FOLDER, name)
        if os.path.getmtime(full) < time.time() - 7 * 86400:
            try:
                os.remove(full)
            except OSError:
                pass
    path = os.path.join(FOLDER, datetime.datetime.now().strftime("screenshot-%Y%m%d-%H%M%S.png"))
    picture.save(path)
    subprocess.run(["powershell", "-NoProfile", "-Command", "& { param($p) Set-Clipboard -LiteralPath $p }", path],
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=True)
    print("image")

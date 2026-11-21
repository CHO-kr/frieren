# python -X utf8 chronicle_test.py : the pure parts of chronicle.py
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chronicle as c  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    if got != want:
        fails += 1
        print(f"FAIL {name}: got {got!r}, want {want!r}")


# questions at the end of a message
check("ko question", c.ask_of("다 만들었어요.\n\n직접 만드신 게 아니라면 닫아 드릴까요?"), "직접 만드신 게 아니라면 닫아 드릴까요?")
check("ko last sentence", c.ask_of("정리했어요. 이대로 올릴까요?"), "이대로 올릴까요?")
check("bold question", c.ask_of("Done.\n\n**Should I push it?**"), "Should I push it?")
check("en request", c.ask_of("Two options above. Let me know."), "Let me know.")
check("ko request", c.ask_of("둘 중 하나를 골라 주세요."), "둘 중 하나를 골라 주세요.")
check("question mid-text", c.ask_of("Why did it fail? Because of X.\n\nFixed it."), None)
check("statement", c.ask_of("모두 끝났어요."), None)
check("empty", c.ask_of(""), None)
check("question then list", c.ask_of("Which one?\n\n- a\n- b"), None)

# test counts
check("pytest", c.test_counts("=== 3 failed, 10 passed in 2.1s ==="), (10, 3))
check("node test", c.test_counts("# tests 12\n# pass 12\n# fail 0"), (12, 0))
check("jest", c.test_counts("Tests:       1 failed, 5 passed, 6 total"), (5, 1))
check("none", c.test_counts("all good"), (None, None))

# what a command is
check("npm test", c.what_of("npm test"), "test")
check("node --test", c.what_of("node --test tests/creator-share.test.mjs"), "test")
check("roomiest test", c.what_of("node roomiest.test.mjs"), "test")
check("herdr check", c.what_of("herdr-app check C:\\x\\mods\\y"), "test")
check("Test-Path is a look", c.what_of("Test-Path C:\\x"), "look")
check("rg is a look", c.what_of("rg --files -g x"), "look")
check("build", c.what_of("npm run build"), "build")
check("render", c.what_of("powershell -File tools\\render.ps1 -Workers 12"), "build")
check("other", c.what_of("git push"), "command")
check("reading a test file is a look", c.what_of("Get-Content -LiteralPath 'tests/creator-data.test.mjs' -Encoding UTF8"), "look")
check("running a test file", c.what_of("python -X utf8 chronicle_test.py"), "test")

# paths named in text
paths = c.find_paths('saved to C:\\\\Users\\\\x\\\\out\\\\a.png and [b](C:/Users/x/b.mp4) and "rel/c.pdf"', "C:\\Users\\x")
check("paths", paths, ["C:\\Users\\x\\out\\a.png", "C:\\Users\\x\\b.mp4", "C:\\Users\\x\\rel\\c.pdf"])
check("memory not loot", c.find_paths("C:\\Users\\x\\.claude-3\\projects\\p\\memory\\note.md", None), [])

print("ok" if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)

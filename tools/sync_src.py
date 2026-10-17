import hashlib
import shutil
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent
FILES = ["app.js", "index.html", "style.css", "manifest.webmanifest", "sw.js"]
TARGETS = [
    SRC / "android-project" / "app" / "src" / "main" / "assets",
    Path(r"E:\waimai-app"),
    Path(r"E:\waimai-app") / "android-project" / "app" / "src" / "main" / "assets",
]


def md5(p):
    return hashlib.md5(p.read_bytes()).hexdigest()


for t in TARGETS:
    if not t.is_dir():
        print("MISSING DIR", t)
        continue
    for f in FILES:
        shutil.copy2(SRC / f, t / f)

print("--- MD5 核对 ---")
for f in FILES:
    hashes = [md5(SRC / f)]
    for t in TARGETS:
        hashes.append(md5(t / f) if (t / f).is_file() else "N/A")
    same = len(set(hashes)) == 1
    print(("OK   " if same else "DIFF ") + f + "  " + " ".join(h[:8] for h in hashes))

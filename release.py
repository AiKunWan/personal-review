"""发版助手：复制构建产物 + 跑解包校验。省掉两步手搓的 PowerShell（它会吞 stdout）。

用法：
    python release.py 2.5.1 类型纯输入

做的事：
    1. 从 build.gradle 读出 versionName，和参数对不上就直接退出（防止名字贴错版本）
    2. 把 app-debug.apk 复制成「个人点评-v<版本>-<说明>.apk」
    3. 跑 verify_apk.py，输出写进 .workbuddy/verify_out.txt（UTF-8，不用 PowerShell 管道）
    4. 校验有 FAIL 就 exit 1，并照原样打印出来

只读 build.gradle 和 APK，不改任何源文件。
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

PY = r"C:\Users\11\.workbuddy\binaries\python\versions\3.13.12\python.exe"
WS = Path(__file__).resolve().parent
GRADLE = Path(r"E:\waimai-app\android-project\app\build.gradle")
BUILT_APK = Path(r"E:\waimai-app\android-project\app\build\outputs\apk\debug\app-debug.apk")
VERIFY = WS / "verify_apk.py"
LOG = WS / ".workbuddy" / "verify_out.txt"


def die(msg):
    print("!! " + msg)
    sys.exit(2)


def main():
    if len(sys.argv) < 3:
        die("用法：python release.py <版本号，如 2.5.1> <一句话说明，如 类型纯输入>")
    ver, desc = sys.argv[1], sys.argv[2]

    # --- 1. 版本号自证 ---
    if not GRADLE.is_file():
        die(f"读不到 {GRADLE}")
    g = GRADLE.read_text(encoding="utf-8")
    gver = re.search(r'versionName\s+"([^"]+)"', g)
    gcode = re.search(r'versionCode\s+(\d+)', g)
    if not gver or not gcode:
        die("build.gradle 里读不到 versionCode / versionName")
    if gver.group(1) != ver:
        die(f"版本号对不上：参数给的是 {ver}，build.gradle 里是 {gver.group(1)}。"
            f"先把 build.gradle 和页面 .ver 改成 {ver} 再跑")

    # --- 2. 复制 ---
    if not BUILT_APK.is_file():
        die(f"没有构建产物：{BUILT_APK}（先跑 gradle assembleDebug）")
    dst = WS / f"个人点评-v{ver}-{desc}.apk"
    shutil.copy2(BUILT_APK, dst)
    print(f"APK  ->  {dst.name}  ({dst.stat().st_size / 1048576:.2f} MB)")

    # --- 3. 校验 ---
    p = subprocess.run([PY, str(VERIFY), str(dst)], capture_output=True)
    out = p.stdout.decode("utf-8", "replace")
    err = p.stderr.decode("utf-8", "replace")
    LOG.write_text(out + ("\n---STDERR---\n" + err if err.strip() else ""), encoding="utf-8")
    print(out.rstrip())
    if err.strip():
        print("---STDERR---\n" + err.rstrip())

    # --- 4. 判定 ---
    tail = re.search(r"共\s*(\d+)\s*项检查，通过\s*(\d+)，失败\s*(\d+)", out)
    if not tail:
        die("校验脚本没输出总结行，可能自己崩了。完整输出见 " + str(LOG))
    total, ok, bad = tail.groups()
    if int(bad) or p.returncode != 0:
        print(f"\n!! 校验没过：{ok}/{total}，失败 {bad}")
        sys.exit(1)
    print(f"\nOK  {ok}/{total} 全过。日志：{LOG}")


if __name__ == "__main__":
    main()

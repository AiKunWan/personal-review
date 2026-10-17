"""升版本：改 E:\\waimai-app\\android-project\\app\\build.gradle 的 versionName / versionCode。

用法：python tools/bump_version.py 2.7.0 [build.gradle路径]
（不给路径时用默认的开发机路径 E://waimai-app//...）

versionCode 由 versionName 推出来：major*10000 + minor*100 + patch
（2.3 -> 20300，2.10 -> 21000，3.0 -> 30000，2.5.1 -> 20501）。
规则见项目 MEMORY.md —— 回退会直接装不上（INSTALL_FAILED_VERSION_DOWNGRADE），
同号也不保险，所以这里强制要求新值**严格大于**当前值。

刻意用 Python 而不是 PowerShell 做替换：那个文件是带中文注释的 UTF-8，
PowerShell 的 Get-Content/Set-Content 来回一趟很容易把编码改坏
（本项目已经踩过 PowerShell 吞 stdout、写 UTF-16 的坑）。
"""
import re
import sys
from pathlib import Path

DEFAULT_P = Path(r"E:\waimai-app\android-project\app\build.gradle")
# 第二个参数可覆盖 build.gradle 路径（移植到别的环境时用），不给就走默认
P = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_P


def code_of(name):
    """'2.7.0' -> 20700。两段（2.7）和三段（2.7.0）都认。"""
    parts = [int(x) for x in re.findall(r"\d+", name)]
    if len(parts) == 3:
        return parts[0] * 10000 + parts[1] * 100 + parts[2]
    if len(parts) == 2:
        return parts[0] * 10000 + parts[1] * 100
    raise ValueError("版本号认不出来：" + name)


def main():
    if len(sys.argv) < 2:
        print("用法：python bump_version.py <versionName>   例如 2.7.0")
        return 2
    new_vn = sys.argv[1].strip()
    try:
        new_vc = code_of(new_vn)
    except ValueError as e:
        print("!! " + str(e))
        return 2

    txt = P.read_text(encoding="utf-8")
    m_vn = re.search(r'versionName\s+"([^"]+)"', txt)
    m_vc = re.search(r'versionCode\s+(\d+)', txt)
    if not m_vn or not m_vc:
        print("!! 读不到 versionName / versionCode")
        return 2

    old_vn, old_vc = m_vn.group(1), int(m_vc.group(1))
    print("before: versionName=%s versionCode=%d" % (old_vn, old_vc))

    if new_vc == old_vc and new_vn == old_vn:
        print("!! 跟当前版本一模一样，没有要改的")
        return 2
    if new_vc <= old_vc:
        print("!! 新 versionCode %d 不大于旧的 %d，拒绝往回改" % (new_vc, old_vc))
        return 2

    new = re.sub(r"versionCode\s+\d+", "versionCode %d" % new_vc, txt, count=1)
    new = re.sub(r'versionName\s+"[^"]+"', 'versionName "%s"' % new_vn, new, count=1)
    if new == txt:
        print("!! 没有任何替换发生")
        return 2

    P.write_text(new, encoding="utf-8")

    chk_vn = re.search(r'versionName\s+"([^"]+)"', new).group(1)
    chk_vc = re.search(r"versionCode\s+(\d+)", new).group(1)
    print("after : versionName=%s versionCode=%s" % (chk_vn, chk_vc))
    # 顺带确认注释没被破坏（中文还在）
    print("中文注释完好: " + ("是" if "单调递增" in new else "否 << 编码可能坏了"))
    # 签名配置必须还在，否则覆盖安装会失败（换签名 = 只能卸载重装、数据全丢）
    print("签名配置还在: " + ("是" if "signingConfigs" in new else "否 << 覆盖安装会失败"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

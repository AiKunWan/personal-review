"""解包 APK 做交叉校验。

装到手机上「看起来没变化」最常见的两种原因都靠这个脚本拦住：
  1. 前端资源没同步进 assets —— APK 里是旧版 app.js
  2. Kotlin 侧没重新编译 —— dex 里还是旧的实现

另外还校验**决定能否覆盖安装的三要素**（包名 / versionCode / 签名指纹）：
这三者只要有一个与手机上已装的版本不一致，系统就会拒绝覆盖安装
（INSTALL_FAILED_UPDATE_INCOMPATIBLE / VERSION_DOWNGRADE），用户只能卸载重装、数据全丢。
所以每次发版都必须把它们自动核对一遍，而不是靠"我记得改过"。

用法: python verify_apk.py <apk路径> [前端源码目录] [build.gradle路径]
"""
import hashlib
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

apk = Path(sys.argv[1])
src = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent
gradle = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(
    r'E:\waimai-app\android-project\app\build.gradle')

# assets/ 下必须与源码逐字节一致的前端文件
ASSETS = ['app.js', 'index.html', 'style.css', 'manifest.webmanifest', 'sw.js']

# dex 里必须出现的符号：少一个就说明原生侧没编进去
DEX_NEEDLES = [
    'AndroidBridge',        # addJavascriptInterface 的注册名（导出下载走的桥）
    'ExportBridge',         # 桥的实现类
    'writeToDownloads',     # 落盘到系统「下载」目录
    'onShowFileChooser',    # v1.2 修的上传断点
    'onConsoleMessage',     # JS 错误能进 logcat
    'onJsConfirm',          # 删除确认走原生对话框
    # v2.3：覆盖安装时清 WebView 资源缓存，避免「升级了界面还是旧的」
    'clearAssetCacheIfUpgraded',
    'app_meta',             # SharedPreferences 文件名（字符串字面量，dex 里查得到）
    'last_version_code',    # 记录已装 versionCode 的 key
]

# 覆盖安装的三要素之一：签名证书指纹。
# 一旦这里 FAIL，说明构建用的 keystore 换了 —— 此时新包**无法**覆盖安装到旧包上，
# 必须先确认清楚，否则用户装不上还不知道为什么。（换签名是重大决定，不要顺手改这个常量。）
EXPECTED_SIGNER_SHA256 = 'B38309F8031294B91396B86BEF2A0E991AD48ED6B8052EFE2674C5227F3CCDB6'

TOOLS = Path(r'E:\android sdk\build-tools\34.0.0')
JAVA_HOME = Path(r'C:\Users\11\.jdks\jbr-21.0.11')

# 上一次已经发出去（并且可能已经装在手机上）的 versionCode。
# 每发一版就把它改成刚发的那个值：低于它 = 手机上装不上（版本降级）。
LAST_RELEASED_VERSION_CODE = 30300

results = []


def check(name, cond, extra=''):
    results.append((bool(cond), name, extra))


def run(cmd):
    """跑外部工具，返回 (退出码, 输出)。批处理必须经 shell 才能被 Windows 执行。"""
    env = dict(os.environ)
    if JAVA_HOME.exists():
        env['JAVA_HOME'] = str(JAVA_HOME)
    try:
        p = subprocess.run(cmd, capture_output=True, env=env, timeout=120, shell=True)
        out = (p.stdout or b'').decode('utf-8', 'replace') + \
              (p.stderr or b'').decode('utf-8', 'replace')
        return p.returncode, out
    except Exception as e:                      # noqa: BLE001
        return -1, f'EXEC-ERROR: {e}'


def read_badging():
    """用 aapt2 读出 APK 的真实包名/版本号 —— 这是系统安装时看到的那份数据。"""
    aapt2 = TOOLS / 'aapt2.exe'
    if not aapt2.exists():
        return None, f'找不到 {aapt2}（ANDROID SDK 路径变了？）'
    code, out = run(f'"{aapt2}" dump badging "{apk}"')
    if code != 0:
        return None, f'aapt2 退出码 {code}: {out.strip()[:160]}'
    m = re.search(
        r"package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'", out)
    if not m:
        return None, 'aapt2 输出里找不到 package 行'
    # 桌面图标名。**这就是用户在 app 外看到的那个名字** —— v3.0 从「外卖评价」
    # 改成「个人点评」，落点是 res/values/strings.xml 的 app_name。
    # 单独抓出来钉住：这类改动没有编译错误，回退了也照样出包。
    ml = re.search(r"application-label:'([^']*)'", out) or \
        re.search(r"application-label-zh[^:]*:'([^']*)'", out)
    return {'package': m.group(1), 'versionCode': m.group(2),
            'versionName': m.group(3), 'label': ml.group(1) if ml else ''}, out


def read_gradle():
    """从 build.gradle 读出配置值。

    必须**先剥注释**：本工程在注释里写了「2.3 -> 20300」这类示例，
    直接正则会把注释里的数字当成真实配置匹配到（本项目已经栽过同类的假断言）。
    """
    if not gradle.exists():
        return None, f'找不到 {gradle}'
    txt = gradle.read_text(encoding='utf-8', errors='replace')
    txt = re.sub(r'/\*.*?\*/', '', txt, flags=re.S)   # 块注释
    txt = re.sub(r'//[^\n]*', '', txt)                # 行注释
    pkg = re.search(r'applicationId\s+"([^"]+)"', txt)
    vc = re.search(r'versionCode\s+(\d+)', txt)
    vn = re.search(r'versionName\s+"([^"]+)"', txt)
    if not (pkg and vc and vn):
        return None, 'applicationId / versionCode / versionName 没读全'
    return {'applicationId': pkg.group(1), 'versionCode': vc.group(1),
            'versionName': vn.group(1)}, txt


def expected_version_code(version_name):
    """versionName -> versionCode，规则：major*10000 + minor*100 + patch"""
    parts = [int(x) for x in re.findall(r'\d+', version_name)]
    while len(parts) < 3:
        parts.append(0)
    return parts[0] * 10000 + parts[1] * 100 + parts[2]


with zipfile.ZipFile(apk) as z:
    names = set(z.namelist())

    # ---- assets 与源码一致性 ----
    for f in ASSETS:
        entry = 'assets/' + f
        lp = src / f
        if entry not in names:
            check(f'assets/{f} 打进包了', False, 'APK 里没有这个条目')
            continue
        if not lp.exists():
            check(f'assets/{f} 有本地源码可比对', False, str(lp))
            continue
        packed = z.read(entry)
        local = lp.read_bytes()
        same = hashlib.md5(packed).hexdigest() == hashlib.md5(local).hexdigest()
        check(f'assets/{f} 与源码一致', same,
              f'apk={len(packed)}B src={len(local)}B' + ('' if same else '  << 不一致'))

    html = z.read('assets/index.html').decode('utf-8', 'replace') \
        if 'assets/index.html' in names else ''
    api = z.read('assets/app.js').decode('utf-8', 'replace') \
        if 'assets/app.js' in names else ''

    # ---- 版本标记与功能标记 ----
    if html:
        m = re.search(r'class="ver">([^<]+)<', html)
        check('index.html 带版本标记', bool(m), m.group(1) if m else '没找到 .ver')
        # index.html 里只需要有「容器」和「新控件」，按钮是 JS 渲染进去的，
        # 拿 data-* 去 index.html 里找必然是假 FAIL
        for marker in ['stats-body', 'f-month', 'view-stats',
                       # v2.4：地点/平台/种类的历史标签容器 + 购买日期输入框
                       'sug-city', 'sug-platform', 'sug-foodType', 'orderDate',
                       # v2.5：图集的箭头与计数
                       # （消费方式在 v3.0 一度改由店铺配置驱动的 <select>，
                       #   自由输入那套被移除；v3.0.1 又回来了；v3.0.2 起**彻底
                       #   只剩自由输入这一种形态** —— 那个下拉连同 channel-pick /
                       #   channel-free 两个包裹层一起删掉了，容器 id 是
                       #   sug-channel-text，不是更早那版的 sug-channel）
                       'lb-prev', 'lb-next', 'lb-count',
                       'sug-channel-text', 'channel-text',
                       # v2.6：份数/重量计量方式切换 + 每斤均价回显
                       'unit-fen', 'unit-jin', 'people-label', 'unit-out',
                       # v2.7：三个大类（段选按钮由 JS 渲染态管理，只需容器里的
                       # 三个 button 和数据属性）+ 筛选面板的大类下拉
                       'f-cat', 'data-cat',
                       # v2.8：待点评（想吃清单）—— tab、折叠表单、列表容器、
                       # 两个 seg（大类 data-wcat / 心动度 data-wpri）和闭环 banner
                       'view-wish', 'wish-form', 'wish-list', 'wq', 'w-sort',
                       'w-count', 'w-extra', 'w-add', 'data-wcat', 'data-wpri',
                       'wish-banner',
                       # v3.0（个人点评）：支持消费方式的自定义编辑器；筛选面板新增的
                       # 店铺 / 平台两个平级维度
                       'sup-channel-box', 'sup-channel-in', 'sup-channel-add',
                       'f-store', 'f-platform',
                       # v3.0.1：店名的必填随大类变（餐饮必填 / 生鲜零食选填），
                       # 所以星号是独立元素；「支持的消费方式」整块随店名显隐；
                       # 小类评价那一格（只有非餐饮、且填了小类才出现）
                       # v3.0.2 起店名**完全选填**，星号恒隐藏，但元素必须留着
                       # （它是显隐钩子）；平台那格也要能收起来（实际消费方式=线下）
                       'sup-field', 'store-req', 'w-req', 'platform-field',
                       'food-note', 'food-note-field',
                       # v3.0.3：订单页顶部汇总条（合计/单数/家店/均价）、
                       # 常驻的大类快捷条、已选条件那一行，以及统计页的吸顶分区导航
                       'sum-total', 'sum-count', 'sum-store', 'sum-avg',
                       'cat-seg', 'filter-chips', 'stats-nav',
                       # v3.2.0：订单页筛选条优化。控件排承载状态 + 一键撤销
                       # （#filter-n 计数位 / #filter-clear 清除按钮），以及把低频
                       # 维度收进去的「更多筛选」层（#more-toggle / #filter-more）
                       'filter-n', 'filter-clear', 'more-toggle', 'filter-more']:
            check(f'index.html 含 {marker}', marker in html)
    if api:
        for marker in ['groupByDay', 'rankRows', 'dayRows', 'data-stats-days',
                       'RANGE_PRESETS', 'orderInRange', 'data-stats-range', 'f-month',
                       # v2.4：页内历史标签 + 可改的下单日期
                       'sug-chip', 'renderSuggest', 'refreshHistory', 'dayValueToTs',
                       'renderDateQuick', 'dayOffsetValue',
                       # v2.5：店铺整体评价（DB v2）/ 多图图集 / 备份格式 v2
                       # （消费方式的预置表 FIELD_PRESETS 已在 v2.7.2 删除，
                       #   别再把它加回检查项 —— 加回来会让所有新包解包校验失败）
                       'storeMeta', 'storeNoteHtml', 'data-noteedit',
                       'collectGallery', 'lbStep', 'parseBackup',
                       # v2.6：份数/重量双模式 + 分开统计
                       'isJin', 'splitByUnit', 'jinPrice', 'unitPriceText',
                       'storeStatsHtml', 'setFormUnit',
                       # v2.7：三个大类驱动小类候选桶与计量方式；
                       # 统计页的大类卡取代了原来的单位分桶卡
                       # （v2.9 删掉了 presetsFor 与 CATEGORIES.words ——
                       #   小类不再有预置词条，加回检查项会让新包全部假 FAIL）
                       'CATEGORY', 'CATEGORIES', 'catOf', 'categoryDef',
                       'setFormCategory', 'categoryStatsCard',
                       # v2.7.1：「大类」下面四格（地点/平台/消费方式/小类）
                       # 的候选全部按大类分开攒，由 HIST_FIELDS + syncHist 统一驱动
                       'syncHist', 'HIST_FIELDS',
                       # v2.8：待点评（DB v3 新增 wishes 仓库）。少了任何一个
                       # 就说明包里的 app.js 还是 v2.7 那版
                       'STORE_WISH', 'getAllWishes', 'putWish', 'deleteWish',
                       'wishCard', 'visibleWishes', 'renderWishes', 'relDay',
                       'goReview', 'pendingWishId', 'bindWishForm',
                       'renderWishSugg',
                       # v3.0（个人点评）：店铺级「支持的消费方式」+ 它驱动实际消费方式；
                       # 列表页按大类分裂的分组（餐饮按店铺 / 其他按小类）；
                       # 筛选面板新增店铺与平台两个平级维度
                       'storeKeyOf', 'channelsOfStore', 'renderSupChannels',
                       'addSupChannel', 'removeSupChannel',
                       'ensureSupLoaded', 'groupOf', 'buildGroups', 'groupStats',
                       'groupCard', 'foodCard', 'deleteOrders', 'data-delgroup',
                       # v3.0.1：表单形态统一收口；小类评价（挂在 storeMeta 的 'food:' 键上）
                       # （实际消费方式的双形态里那个 <select> 在 v3.0.2 被删掉了，
                       #   连带 fillChannelSelect / switchChannelMode 一起 —— 别再
                       #   把它们加回检查项，加回来会让所有新包解包校验失败）
                       'readChannel', 'setChannel', 'applyFormMode',
                       'suggKeyOf', 'applyWishMode',
                       'FOOD_GROUP_PREFIX', 'isFoodMetaKey', 'storeMetaRows',
                       'writeNoteRow', 'refreshFoodNote', 'loadFoodNote',
                       'saveFoodNoteIfDirty',
                       # v3.0.2：店铺身份改成**纯店名**（地点退出身份），
                       # 老键 `店名|地点` 读取时归一并在启动时一次性写回；
                       # storeMeta 行改带 kind 字段判归属（不再靠键前缀）；
                       # 「支持的消费方式」由实际消费方式**沉淀**而来
                       'normStoreKey', 'orderKeyOf', 'kindOfRow', 'mergeMetaRow',
                       'migrateMetaKeys', 'storeNameOf', 'absorbChannelIntoStore',
                       # v3.0.3：订单页汇总条 / 已选条件 / 快捷条高亮，
                       # 以及统计页的大类口径（含选中后的小类分解）
                       'updateSumBar', 'renderFilterChips', 'syncCatSeg',
                       'subCategoryStatsCard', 'catCls', 'FILTER_DIMS',
                       'statsCat', 'STATS_CAT_LS',
                       # v3.2.0：同款订单**自动归组**。判定键 = 9 项业务字段，
                       # 刻意放过 rating / review / totalPrice / **date** ——
                       # 评分和评语在组头合并展示，金额各算各的，日期要能跨天
                       # （否则「这款点了几次、每次什么时候、每次多少钱」根本看不到）。
                       # 归组是渲染时按 dupKeyOf 现算的，库里没有任何标记，
                       # 所以既没有「合并」动作也没有撤销。readRating 一起钉上：
                       # 组头平均分会产出 4.5 这种小数，读分数那格不能再退化成 parseInt
                       'dupKeyOf', 'DUP_FIELDS', 'dupGroupHead', 'dupBlockHtml',
                       'reviewListHtml', 'dup-block-stat', 'dup-block-sub',
                       'readRating',
                       # v3.2.0：筛选项上直接写「这个值有几单」（分面计数）。
                       # 口径 = 把该维换成候选值后**重跑一遍完整过滤**（均价区间、
                       # 关键词都算），所以数字和「点进去看到的东西」同源。
                       # readFilters 的 override 是它唯一的后门，过滤出口仍然只有
                       # filterStores 一个 —— 少了这几个就说明包里还是旧版列表
                       'readFilters', 'facetCountFor', 'renderFacetCounts', 'seg-num',
                       # v3.2.0：订单页筛选条优化。filterCount 数生效条数、
                       # renderFilterBar 统一刷控件排三处状态、resetFilters 是
                       # 「重置筛选 / 清除筛选 / 清除全部」三个入口共用的唯一出口
                       'filterCount', 'renderFilterBar', 'resetFilters']:
            check(f'app.js 含功能标记 {marker}', marker in api)

        # 反向断言：预置词条必须**不在**包里（v2.9 起「小类」只用历史值）。
        # 正向清单只能证明「该有的在」，证不了「不该有的没了」——
        # 而「小类又冒出几个没点过的固定标签」正是那一版要杜绝的事。
        # 查之前先剥注释：正反两面的说明里都会出现这些名字，注释不算代码。
        def strip_js_comments(s):
            s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
            return re.sub(r'//[^\n]*', '', s)

        body = strip_js_comments(api)
        _left = [x for x in ('presetsFor', '.words') if x in body]
        check('app.js 里已无预置词条（没有 presetsFor，也没有 .words）',
              not _left, ('还在：' + '、'.join(_left)) if _left else '')
        # 反向断言：同款归组改成**自动**之后，「查重条 + 手点并组 + 撤销」那一整套
        # 必须彻底消失 —— 留着它们就意味着包里还躺着一套往订单上写 dupGroup 标记的
        # 出口，而列表渲染已经不认那个标记了（写了也白写，只会白白改动数据）。
        _gone = [x for x in ('mergeGroupPlan', 'mergeOneGroup', 'mergeAllDupGroups',
                             'findDupGroups', 'foldGroup', 'foldGroups',
                             'unfoldGroup', 'unfoldAllGroups', 'stripDupGroup',
                             'groupedMap', 'liveDupGroupIds', 'renderDupBar',
                             'dupPanelHtml', 'onDupClick', 'undup',
                             'data-dupfold', 'data-dupall', 'data-unfold',
                             'data-undupall', 'dup-bar')
                 if x in body]
        # dupGroup / dupAt 用词边界单独查：x in body 会被保留的 dupGroupHead 撞上
        if re.search(r'\bdupGroup\b|\bdupAt\b', body):
            _gone.append('dupGroup 标记')
        check('app.js 里已无手动并组 / 撤销那一套（改成同款自动归组）',
              not _gone, ('还在：' + '、'.join(_gone)) if _gone else '')

        # 反向断言之二（v3.0.2）：实际消费方式那个 <select> 及其双形态的痕迹
        # 必须清干净。留着旧函数不报错、也不影响运行 —— 只会在下次改这块时
        # 把人引到一条已经废弃的分支上，所以钉死。
        _dead = [x for x in ('fillChannelSelect', 'switchChannelMode', 'channelMode')
                 if x in body]
        check('app.js 里已无「实际消费方式下拉/双形态」的残留'
              '（fillChannelSelect / switchChannelMode / channelMode）',
              not _dead, ('还在：' + '、'.join(_dead)) if _dead else '')

    # ---- dex 符号 ----
    dex_blobs = [z.read(n) for n in names if n.endswith('.dex')]
    check('APK 里存在 dex', len(dex_blobs) > 0, f'{len(dex_blobs)} 个')
    blob = b''.join(dex_blobs)
    for needle in DEX_NEEDLES:
        check(f'dex 含 {needle}', needle.encode() in blob)

    # ---- 签名 ----
    # 注意别去 META-INF 里找 .RSA/.SF：v2/v3 签名放在 ZIP 中央目录之后的
    # APK Signing Block 里，META-INF 下什么都没有，照 v1 的规则查必然误报。
    check('含 AndroidManifest.xml', 'AndroidManifest.xml' in names)
    raw = apk.read_bytes()
    has_v2 = b'APK Sig Block 42' in raw
    v1 = sorted(n for n in names if n.startswith('META-INF/')
                and n.upper().endswith(('.RSA', '.DSA', '.EC', '.SF')))
    check('APK 已签名（v2/v3 签名块 或 v1 签名文件）', has_v2 or bool(v1),
          ('APK Signing Block' if has_v2 else '') + (('  v1: ' + ', '.join(v1)) if v1 else ''))

# ---- 覆盖安装三要素：包名 / versionCode / 签名指纹 ----
badging, badging_raw = read_badging()
grad, _gradle_txt = read_gradle()

if badging is None:
    check('能读取 APK 的包信息（aapt2）', False, badging_raw)
if grad is None:
    check('能读取 build.gradle 的版本配置', False, badging_raw if badging is None else grad)

if badging and grad:
    check('APK 包名与 build.gradle 一致',
          badging['package'] == grad['applicationId'],
          f"apk={badging['package']} gradle={grad['applicationId']}")
    check('APK versionCode 与 build.gradle 一致',
          badging['versionCode'] == grad['versionCode'],
          f"apk={badging['versionCode']} gradle={grad['versionCode']}")
    check('APK versionName 与 build.gradle 一致',
          badging['versionName'] == grad['versionName'],
          f"apk={badging['versionName']} gradle={grad['versionName']}")
    # 桌面图标名 = 用户在 app 外看到的那个。改错了不会报任何错，只是名字悄悄退回旧的
    check('APK 桌面图标名是「个人点评」',
          badging['label'] == '个人点评', f"label={badging['label']}")
    # versionCode 必须能由 versionName 推出来，防止两处各改一个、悄悄错位
    want = expected_version_code(grad['versionName'])
    check('versionCode 符合命名规则 major*10000+minor*100+patch',
          grad['versionCode'] == str(want),
          f"versionName={grad['versionName']} 期望 {want}，实际 {grad['versionCode']}")
    # versionCode 绝不能回退，否则无法覆盖安装（INSTALL_FAILED_VERSION_DOWNGRADE）。
    # 这个常量每次发版**手动**更新成刚发出去的那版 —— 它是唯一能拦住
    # 「顺手把版本号改小了」的护栏（本项目 v1.2~v2.2 就一直卡在 1，白躲了十个版本）。
    check(f'versionCode 不低于上一版（{LAST_RELEASED_VERSION_CODE}）',
          int(grad['versionCode']) >= LAST_RELEASED_VERSION_CODE,
          f"当前 {grad['versionCode']}，上一版 {LAST_RELEASED_VERSION_CODE}")

if html and grad:
    m = re.search(r'class="ver">v?([^<]+)<', html)
    got = m.group(1).strip() if m else '?'
    check('页面版本标记与 build.gradle versionName 一致',
          got == grad['versionName'], f'html=v{got} gradle={grad["versionName"]}')

apksigner = TOOLS / 'apksigner.bat'
if not apksigner.exists():
    check('能验证签名指纹（apksigner）', False, f'找不到 {apksigner}')
else:
    code, out = run(f'"{apksigner}" verify --print-certs "{apk}"')
    m = re.search(r'SHA-256 digest:\s*([0-9a-fA-F]+)', out)
    got = m.group(1).upper() if m else ''
    check('签名指纹与既有版本一致（决定能否覆盖安装）',
          got == EXPECTED_SIGNER_SHA256,
          (got or f'apksigner 退出码 {code}') +
          ('' if got == EXPECTED_SIGNER_SHA256 else f'  期望 {EXPECTED_SIGNER_SHA256[:16]}...'))

size_mb = apk.stat().st_size / 1024 / 1024
lines = [f'APK: {apk.name}  ({size_mb:.2f} MB)']
if badging:
    lines.append(f"包名 {badging['package']}   versionCode {badging['versionCode']}"
                 f"   versionName {badging['versionName']}")
lines.append('')
fails = 0
for ok, name, extra in results:
    if not ok:
        fails += 1
    lines.append(('PASS  ' if ok else 'FAIL  ') + name + (f'   [{extra}]' if extra else ''))
lines.append('')
lines.append(f'共 {len(results)} 项检查，通过 {len(results) - fails}，失败 {fails}')

out = '\n'.join(lines)
sys.stdout.write(out + '\n')
try:
    (Path(__file__).parent / 'verify_report.txt').write_text(out + '\n', encoding='utf-8')
except OSError:
    pass

sys.exit(1 if fails else 0)

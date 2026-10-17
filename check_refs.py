"""静态检查 app.js 里引用的 #id 是否都存在于 index.html。
WebView 里 $() 取不到元素只会得到 null，
后续 .addEventListener 立刻抛 TypeError —— 而 init 的 try/catch 会把它
变成一句 alert，很容易被当成「应用坏了」。提前拦住这类拼写错误。
"""
import re
import sys
from pathlib import Path

base = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
js = (base / 'app.js').read_text(encoding='utf-8')
html = (base / 'index.html').read_text(encoding='utf-8')

html_ids = set(re.findall(r'id="([^"]+)"', html))
# JS 模板字符串里动态拼的 id（如 `#view-${name}`）不参与检查
js_ids = set(re.findall(r"""\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)""", js))

missing = sorted(js_ids - html_ids)
print(f'index.html 里的 id 共 {len(html_ids)} 个')
print(f'app.js 静态引用的 id 共 {len(js_ids)} 个')
print()

if missing:
    print('*** 引用了但 HTML 里不存在的 id ***')
    for m in missing:
        print('   #' + m)
    sys.exit(1)

print('OK: app.js 引用的 id 全部存在于 index.html')

# 表单字段顺序。这几格是按「填单时的思路」排的，挪错一格**不会报任何错**，
# 只会悄悄打断字段之间的依赖，改顺序时顺手改这份清单 —— 它报错就是在提醒你
# 「你确实动了它」。
#
# v3.0.2 定版（整体反转成「先写事实、最后写归属」）：
#   购买日期｜地点 → 大类 → 计量方式 → 小类 → 小类评价 → 点的什么
#   → 总价｜人数 → 综合评价 → 实际消费方式 → 平台 → 店铺名称
#   → 支持的消费方式 → 实物图片
# 三条约束钉着它，挪之前先想清楚：
#   ① **大类必须排在计量方式之前**：大类会给计量方式一个默认值，反过来就成了
#      「先选手动值、再被大类覆盖」。
#   ② 地点 / 平台 / 小类 / 实际消费方式四格的候选都按大类分桶，所以大类在它们之前。
#   ③ **小类评价紧贴小类**：它评价的对象就是上面那格，中间不能再插字段
#      （它对餐饮不显示，但字段常驻 HTML、靠 hidden 收起，所以照样要列）。
# 「店铺名称」和「支持的消费方式」一起排在末尾：后者是**店铺属性**、
# 从「实际消费方式」沉淀而来，没店名时整块收起。
_form = html[html.index('id="order-form"') : html.index('</form>')]
EXPECTED_FORM_FIELDS = ['购买日期', '地点', '大类', '计量方式', '小类', '小类评价（可选）',
                        '点的什么', '总价（元）*', '综合评价', '实际消费方式', '平台',
                        '店铺名称', '支持的消费方式']


def _field_pos(label):
    return _form.find('<span>%s' % label)


_absent = [f for f in EXPECTED_FORM_FIELDS if _field_pos(f) < 0]
if _absent:
    print('*** 表单里找不到这些字段：' + '、'.join(_absent) + ' ***')
    sys.exit(1)
_actual = sorted(EXPECTED_FORM_FIELDS, key=_field_pos)
if _actual != EXPECTED_FORM_FIELDS:
    print('*** 表单字段顺序变了 ***')
    print('   期望：' + ' → '.join(EXPECTED_FORM_FIELDS))
    print('   实际：' + ' → '.join(_actual))
    sys.exit(1)
print('OK: 表单字段顺序符合预期（' + ' → '.join(EXPECTED_FORM_FIELDS) + '）')

# 待点评表单的字段顺序。切片起点必须**显式给 id="wish-form"**：
# 上面那段用的是「第一个 </form>」，而 wish-form 排在 order-form 之后，
# 第一个 </form> 永远属于 order-form —— 所以这里得从自己的起点往后找自己的终点。
# 反过来说：**wish-form 一旦挪到 order-form 前面，上面那段切片就会当场误报**，
# index.html 里留了注释钉着这件事。
_wish_start = html.index('id="wish-form"')
_wish = html[_wish_start: html.index('</form>', _wish_start)]
# v3.0.1 起名称那格后面跟的是 <span class="req">*</span>（星号要能单独藏起来，
# 因为必填随大类变），所以这里匹配到名称本身为止，不带那个星号。
EXPECTED_WISH_FIELDS = ['店铺 / 商品名称', '地点', '大类', '小类',
                        '想吃什么', '为什么想吃', '心动度']

_wish_absent = [f for f in EXPECTED_WISH_FIELDS if _wish.find('<span>%s' % f) < 0]
if _wish_absent:
    print('*** 待点评表单里找不到这些字段：' + '、'.join(_wish_absent) + ' ***')
    sys.exit(1)
_wish_actual = sorted(EXPECTED_WISH_FIELDS, key=lambda f: _wish.find('<span>%s' % f))
if _wish_actual != EXPECTED_WISH_FIELDS:
    print('*** 待点评表单字段顺序变了 ***')
    print('   期望：' + ' → '.join(EXPECTED_WISH_FIELDS))
    print('   实际：' + ' → '.join(_wish_actual))
    sys.exit(1)
print('OK: 待点评表单字段顺序符合预期（' + ' → '.join(EXPECTED_WISH_FIELDS) + '）')

# 反向提示：HTML 里有 id 但 JS 完全没引用（正常情况会有一些，仅作信息）
unused = sorted(html_ids - js_ids)
if unused:
    print()
    print('信息：HTML 里未被 $() 静态引用的 id（可能是模板内联、由 closest 命中或纯样式钩子）')
    for u in unused:
        print('   #' + u)

# 关键：data-* 钩子双向对齐。
# 只写一半不会报任何错：closest() 查了但模板里没人产出 → 按钮点了没反应；
# 产出了但没人查 → 纯装饰。两种都只能等上线后才发现，所以在这里硬拦。
#
# 产出的来源有**两处**：app.js 的模板字符串，以及写死在 index.html 里的元素。
# 后者以前没有（钩子全是 JS 渲染出来的），v3.0.3 加了统计页分区导航和
# 订单页大类快捷条之后就有了 —— 只扫 js 会把它们误报成「点了没反应」。
queried = set(re.findall(r"""closest\(\s*'\[(data-[a-z-]+)\]'\s*\)""", js))
produced = set(re.findall(r'\b(data-[a-z-]+)=', js)) | \
    set(re.findall(r'\b(data-[a-z-]+)[="]', html))

print()
print(f'app.js 里 closest() 查询的 data-* 钩子 {len(queried)} 个')
for a in sorted(queried):
    print('   [' + a + ']')

orphan_query = sorted(queried - produced)
if orphan_query:
    print('*** 被查询但模板里从没渲染过的钩子（点了不会有反应）***')
    for a in orphan_query:
        print('   [' + a + ']')
    sys.exit(1)
print('OK: 每个被查询的 data-* 钩子都有模板产出')

# 这些是给 CSS 或 dataset 直接读的，不走 closest() 查询，属正常
DATASET_ONLY = {'data-dir', 'data-key', 'data-sug-value'}
unused_hook = sorted(produced - queried - DATASET_ONLY)
if unused_hook:
    print('信息：渲染了但没有 closest() 查询的 data-*（由 dataset 直接读或纯装饰）')
    for a in unused_hook:
        print('   ' + a)

# 写在 index.html 里、由 app.js 消费的钩子，单独核对（不经过 JS 模板生成）
# 注意：app.js 可能通过 element.dataset.xxx 读取，字面量对不上是正常的，
# 所以这里只做信息展示，不作为失败条件。
html_hooks = sorted(set(re.findall(r'\b(data-[a-z-]+)[="]', html)))
print()
for attr in html_hooks:
    print(f'{attr:24} 在 index.html: True   字面量出现在 app.js: {attr in js}')

# 反向检查：app.js 模板里用到的 class 是否在 style.css 里有定义。
# 漏写样式不会报错，只会「看着没生效」，比报错更难发现，所以单独拦一道。
css_path = base / 'style.css'
if css_path.exists():
    css = css_path.read_text(encoding='utf-8')
    js_classes = set()
    # class="rank-no${idx < 3 ? ' top' : ''}" 这种插值要先摘掉，
    # 否则 ${...} 里的表达式会被当成类名，报一堆 .' .=== 之类的假阳性
    js_for_class = re.sub(r'\$\{[^}]*\}', ' ', js)
    for m in re.finditer(r'class="([^"]+)"', js_for_class):
        for c in m.group(1).split():
            js_classes.add(c)
    # 纯状态修饰类由 JS 动态加，通常没有独立样式规则
    modifiers = {'active', 'on', 'arming', 'top', 'small', 'danger', 'primary'}
    css_classes = set(re.findall(r'\.([A-Za-z][A-Za-z0-9_-]*)', css))
    undefined = sorted(c for c in js_classes - css_classes if c not in modifiers)
    print()
    print(f'app.js 模板使用的 class 共 {len(js_classes)} 个，style.css 未定义的 {len(undefined)} 个')
    if undefined:
        print('*** 在 app.js 里用到但没有对应样式的 class ***')
        for u in undefined:
            print('   .' + u)

/**
 * 运行时冒烟测试：在 Node 里用最小 DOM 桩执行 app.js，
 * 直接调用聚合 / 排序 / 过滤 / 统计渲染，确认没有运行时异常、数值正确。
 * 输出全部用 ASCII，避免 Windows 控制台编码把中文变成乱码。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

/**
 * 真实 `<form>.reset()` 会把表单里所有控件的**值**清空。
 * 桩必须照做 —— 否则「resetForm 之后那格是空的吗」这类断言永远看着是通过的
 * （读到的还是上一次写进去的值），而真实浏览器里它是空的。
 * 具体实现放在 els 建好之后赋值（见下）。
 */
let resetEls = () => {};

function makeEl(id) {
  const el = {
    id: id || '',
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    files: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    // <form>.reset() 的桩。没有它 resetForm() 会直接 TypeError。
    // 真 reset 会清空值，这里也必须清 —— 见 resetEls 上方的说明。
    reset() { resetEls(); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    remove() {},
    click() {},
  };
  // innerHTML 用访问器实现，赋值时顺便把 value 清空 —— 真实 <select> 重建 option 后
  // 选中值就是这样丢的，正是 fillFilterOptions 里「先存后还」要防的那个坑。
  // 有了它，「重建后选中值还在吗」才测得出真假。
  let html = '';
  // <select>.options 的桩。真实 DOM 里 option.textContent 和 innerHTML 是**同一份
  // 数据的两面** —— 改了文字，innerHTML 里那一段也跟着变。桩如果只让 options 动、
  // innerHTML 不动，读 innerHTML 的断言和读 options 的断言就各看各的，
  // 两边都"通过"却谁也没验证真实行为。所以这里把 textContent 的赋值回写进 innerHTML。
  const opts = [];
  const rebuildOptions = () => {
    opts.length = 0;
    const re = /<option value="([^"]*)">([^<]*)<\/option>/g;
    let m;
    while ((m = re.exec(html))) {
      const value = m[1];
      const opt = { value, _text: m[2] };
      Object.defineProperty(opt, 'textContent', {
        get() { return opt._text; },
        set(v) {
          const before = `<option value="${value}">${opt._text}</option>`;
          opt._text = String(v);
          html = html.replace(before, `<option value="${value}">${opt._text}</option>`);
        },
      });
      opts.push(opt);
    }
  };
  Object.defineProperty(el, 'options', { get() { return opts; } });
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); el.value = ''; rebuildOptions(); },
  });
  // textContent 同理：真实 DOM 里它永远是字符串，赋个数字进去会被转成 '9'。
  // 不做这一步的话，「汇总条写了几个数」的断言会拿 9 === '9' 去比而假失败，
  // 逼着测试到处写 String() —— 桩的行为离真实越远，测出来的结论越不可信。
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); },
  });
  return el;
}

const els = new Map();
resetEls = () => { for (const e of els.values()) e.value = ''; };
const getEl = (sel) => {
  if (!els.has(sel)) els.set(sel, makeEl(sel));
  return els.get(sel);
};

/**
 * 大类快捷条的按钮桩。
 * app.js 的 renderFacetCounts 走 `$$('#cat-seg .seg-btn')`，把「点它有几单」写进
 * 每个按钮内部的 `.seg-num`。只桩出这一组就够 —— 其余 querySelectorAll 一律返回空。
 */
const segBtns = ['', '餐饮', '生鲜', '零食'].map((cat) => {
  const b = makeEl('seg-' + (cat || 'all'));
  b.getAttribute = (n) => (n === 'data-cat' ? cat : null);
  const num = makeEl('num-' + (cat || 'all'));
  b.querySelector = (s) => (s === '.seg-num' ? num : null);
  b.__num = num;
  return b;
});

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Error, Number, String, Array, Object, parseFloat, parseInt, isNaN,
  alert: () => {},
  crypto: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) },
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  },
  navigator: {},
  location: { protocol: 'https:', hostname: 'appassets.androidplatform.net' },
  document: {
    querySelector: (s) => getEl(s),
    querySelectorAll: (s) => (s === '#cat-seg .seg-btn' ? segBtns : []),
    createElement: () => makeEl(),
    body: makeEl('body'),
    addEventListener() {},
  },
  // indexedDB 桩：open 永不回调，init 会一直 await，不影响我们直接调函数
  indexedDB: { open: () => ({}) },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// TEST 代码在 VM 里执行，取元素的桩要显式挂进去
sandbox.getEl = getEl;
sandbox.segBtns = segBtns;

const TEST = `
;(function runTests() {
  const out = [];
  // extra 里的换行必须压平：渲染出来的 HTML 片段是带换行的，直接拼进去会让
  // 一条断言占好几行 —— 汇总里的 total 用的是行数，于是「断言数」被虚高的行数
  // 冒充了（本脚本曾经用 total=585 报过实际只有 334 条断言）。
  // 压成 ' | ' 之后每条断言恰好一行，输出可 grep，计数也真实。
  const ok = (name, cond, extra) => out.push((cond ? 'PASS  ' : 'FAIL  ') + name +
    (extra ? '   [' + String(extra).replace(/[\\r\\n]+/g, ' | ') + ']' : ''));

  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const IMG = 'data:image/jpeg;base64,/9j/AAA';
  const mk = (id, name, i, rating, price, review) => ({
    id: id + i, storeKey: name + '|哈尔滨', storeName: name, city: '哈尔滨',
    platform: i % 2 ? '美团' : '饿了么', foodType: i % 3 ? '快餐' : '日料', channel: '仅外卖',
    items: i % 2 ? '汉堡' : '寿司', totalPrice: price, people: 1, rating: rating,
    review: review || '还行', dishImage: i === 0 ? IMG : null, date: now - (i + 1) * DAY,
  });

  const orders = [
    // A 店：只有 1 单，5 分 —— 正是「少样本霸榜」的典型
    mk('a', 'A店', 0, 5, 100),
    // B 店：20 单，均分 4.8 —— 真正常去、评价稳定的店（评价里带独有词，用于搜索测试）
    ...Array.from({ length: 20 }, (_, i) => mk('b', 'B店', i, i < 16 ? 5 : 4, 30, '招牌寿司很新鲜')),
    // C 店：5 单，均分 3.0 —— 差店
    ...Array.from({ length: 5 }, (_, i) => mk('c', 'C店', i, 3, 25)),
    // D 店：10 单，均分 4.5
    ...Array.from({ length: 10 }, (_, i) => mk('d', 'D店', i, i < 5 ? 5 : 4, 40)),
  ];

  const stores = groupByStore(orders);
  ok('groupByStore returns 4 stores', stores.length === 4, 'got ' + stores.length);

  const A = stores.find((s) => s.name === 'A店');
  const B = stores.find((s) => s.name === 'B店');
  const C = stores.find((s) => s.name === 'C店');
  const D = stores.find((s) => s.name === 'D店');
  ok('A.avgRating is exactly 5', A.avgRating === 5, 'got ' + A.avgRating);
  ok('B.avgRating is 4.8', Math.abs(B.avgRating - 4.8) < 1e-9, 'got ' + B.avgRating);

  const gmean = orders.reduce((s, o) => s + o.rating, 0) / orders.length;
  ok('weightedRating exists on every store', stores.every((s) => typeof s.weightedRating === 'number'));
  ok('A.weightedRating < its raw 5.0 (shrinkage applied)', A.weightedRating < 5, 'w=' + A.weightedRating.toFixed(3) + ' raw=5');
  ok('B.weightedRating stays close to 4.8 (within 0.1)', Math.abs(B.weightedRating - 4.8) < 0.1, 'w=' + B.weightedRating.toFixed(3));
  ok('A.weightedRating === (5 + C*g)/(1+C)', Math.abs(A.weightedRating - (5 + RATING_C * gmean) / (1 + RATING_C)) < 1e-9);
  ok('shrinkage cost for A is large (>0.3)', 5 - A.weightedRating > 0.3, 'cost=' + (5 - A.weightedRating).toFixed(3));
  ok('shrinkage cost for B is small (<0.1)', 4.8 - B.weightedRating < 0.1, 'cost=' + (4.8 - B.weightedRating).toFixed(3));
  ok('A is punished much harder than B', (5 - A.weightedRating) > 4 * (4.8 - B.weightedRating),
     'A=' + (5 - A.weightedRating).toFixed(3) + ' B=' + (4.8 - B.weightedRating).toFixed(3));

  // 核心回归：加权后 B 店（20 单 4.8）必须排到 A 店（1 单 5.0）前面
  sortState.key = 'rating'; sortState.dir = 'desc';
  const sorted = sortStores(stores);
  ok('weighted sort puts B (20 orders) before A (1 order)', sorted.findIndex((s) => s.name === 'B店') < sorted.findIndex((s) => s.name === 'A店'),
     'order=' + sorted.map((s) => s.name).join('>'));
  ok('worst store C ranks last', sorted[sorted.length - 1].name === 'C店');

  // 分项数值
  ok('B.perCapita === 30', Math.abs(B.perCapita - 30) < 1e-9, 'got ' + B.perCapita);
  ok('B.avgPrice === 30', Math.abs(B.avgPrice - 30) < 1e-9);
  ok('B.platforms collected (both)', B.platforms.length === 2, 'got ' + B.platforms.join('/'));

  // 关键词过滤
  getEl('#f-city').value = '';
  getEl('#f-food').value = '';
  getEl('#f-channel').value = '';
  getEl('#f-min').value = '';
  getEl('#f-max').value = '';
  getEl('#q').value = '招牌寿司';
  const hit = filterStores(orders);
  ok('search review text matches only B', hit.length === 1 && hit[0].name === 'B店', 'n=' + hit.length);
  getEl('#q').value = 'B店';
  ok('search by store name works', filterStores(orders).length === 1);
  getEl('#q').value = 'C店';
  ok('search by another store name works', filterStores(orders).length === 1);
  getEl('#q').value = 'zzz-no-such';
  ok('search with no hit returns 0', filterStores(orders).length === 0);
  getEl('#q').value = '';

  // 统计渲染：模板字符串最容易在这里抛错
  let statsHtml = '';
  try {
    renderStats(orders);
    statsHtml = getEl('#stats-body').innerHTML;
    ok('renderStats ran without throwing', true);
  } catch (e) {
    ok('renderStats ran without throwing', false, e && e.message);
  }
  ok('stats shows total spend 1225', statsHtml.indexOf('1225') !== -1, 'total=' + orders.reduce((s, o) => s + o.totalPrice, 0));
  ok('stats has 4 stat cards', (statsHtml.match(/stat-card/g) || []).length === 4, 'n=' + (statsHtml.match(/stat-card/g) || []).length);
  ok('stats has 6 month bars', (statsHtml.match(/1[0-2]月|[1-9]月/g) || []).length >= 6);
  ok('stats lists platform 美团', statsHtml.indexOf('美团') !== -1);
  ok('stats lists food type 日料', statsHtml.indexOf('日料') !== -1);

  // ---- v2.1：店铺排行 + 每日 / 星期明细 ----
  const total = orders.reduce((s, o) => s + o.totalPrice, 0);

  ok('statsDays default is 14', statsDays === 14, 'got=' + statsDays);
  ok('_statOrders kept for re-render', _statOrders.length === orders.length, 'got=' + _statOrders.length);

  const dn = groupByDay(orders);
  ok('groupByDay counts distinct days', dn.length === 20, 'got=' + dn.length);
  ok('groupByDay sorted newest first', dn[0].key > dn[dn.length - 1].key, dn[0].key + ' -> ' + dn[dn.length - 1].key);
  ok('groupByDay counts sum to order count', dn.reduce((s, d) => s + d.count, 0) === orders.length);
  ok('groupByDay amounts sum to total spend', Math.abs(dn.reduce((s, d) => s + d.amount, 0) - total) < 1e-9);
  ok('groupByDay([]) returns empty array', groupByDay([]).length === 0);

  ok('dayKey is zero-padded YYYY-MM-DD', dayKey(new Date(2026, 0, 5).getTime()) === '2026-01-05', 'got=' + dayKey(new Date(2026, 0, 5).getTime()));
  ok('dayLabelFromKey maps 2026-09-19 to 9/19 周六', dayLabelFromKey('2026-09-19') === '9/19 周六', 'got=' + dayLabelFromKey('2026-09-19'));
  ok('dayLabelFromKey maps 2026-09-20 to 9/20 周日', dayLabelFromKey('2026-09-20') === '9/20 周日', 'got=' + dayLabelFromKey('2026-09-20'));

  const dayHtml = dayRows(dn);
  ok('dayRows emits one .day-row per day', (dayHtml.match(/day-row/g) || []).length === 20, 'n=' + (dayHtml.match(/day-row/g) || []).length);
  ok('dayRows shows order count per day', dayHtml.indexOf('单</span>') !== -1);
  ok('dayRows([]) degrades gracefully', dayRows([]).indexOf('没有订单') !== -1);

  const rk = rankRows([{ label: '甲', value: 10, text: '10 单' }, { label: '乙', value: 5, text: '5 单' }]);
  ok('rankRows numbers entries from 1', rk.indexOf('>1</span>') !== -1 && rk.indexOf('>2</span>') !== -1);
  ok('rankRows emits one row per item', (rk.match(/rank-row/g) || []).length === 2);
  ok('rankRows([]) degrades gracefully', rankRows([]).indexOf('暂无数据') !== -1);

  ok('stats has 点得最多的店 section', statsHtml.indexOf('点得最多的店') !== -1);
  ok('stats has 花钱最多的店 section', statsHtml.indexOf('花钱最多的店') !== -1);
  ok('stats has 每日消费 section', statsHtml.indexOf('每日消费') !== -1);
  ok('stats has 星期分布 section', statsHtml.indexOf('星期分布') !== -1);
  // v3.0.3：纪录卡只留**订单级**极值。「点得最多 / 花得最多」原来也在这儿，
  // 但和下面两张 TOP5 卡的第一名是同一个答案 —— 同页说两遍既占地方又像两套口径。
  // 判据带 </span> 收尾：「点得最多的店」那个卡标题里也含「点得最多」四个字。
  //
  // 注意：本文件整体是一个模板字符串，**正则里的反斜杠会被吞掉**
  // （反斜杠 + s 会退化成 s；反斜杠 + 斜杠 会变回裸斜杠，把正则提前闭合 →
  //  报 Invalid regular expression flags）。要用正则得写双反斜杠，
  // 能不用就不用 —— 这里一律走 indexOf + slice。
  // 同理，注释里也别出现反引号，它会当场把模板字符串截断。
  ok('纪录卡只剩订单级极值（不再重复 TOP5 的店铺第一名）',
     statsHtml.indexOf('单日最多单') !== -1 && statsHtml.indexOf('单日最贵') !== -1 &&
     statsHtml.indexOf('最贵的一单') !== -1 &&
     statsHtml.indexOf('点得最多</span>') === -1 &&
     statsHtml.indexOf('花得最多</span>') === -1);
  const priciestCell = statsHtml.slice(statsHtml.indexOf('最贵的一单'));
  ok('最贵的一单带金额 / 店名 / 日期',
     priciestCell.indexOf('<b>¥') !== -1 && priciestCell.indexOf('<small>') !== -1 &&
     priciestCell.indexOf('</small>') !== -1);
  ok('stats default window caption is 最近 14 天', statsHtml.indexOf('最近 14 天') !== -1);
  ok('stats has 7/14/30 range buttons', (statsHtml.match(/data-stats-days=/g) || []).length === 3);
  ok('current range button marked on', statsHtml.indexOf('class="seg-btn on" data-stats-days="14"') !== -1);
  ok('rank sections list all 4 stores twice', (statsHtml.match(/rank-row/g) || []).length === 8, 'n=' + (statsHtml.match(/rank-row/g) || []).length);

  // 空数据不应抛错
  try { renderStats([]); ok('renderStats([]) safe', true); } catch (e) { ok('renderStats([]) safe', false, e.message); }

  // ---- v2.2：时间范围（统计页）+ 月份（店铺筛选） ----
  ok('RANGE_PRESETS has 5 presets', Object.keys(RANGE_PRESETS).length === 5, Object.keys(RANGE_PRESETS).join('/'));
  ok('orderInRange(ts, null) always true', orderInRange(now, null) === true);

  const sepWin = RANGE_PRESETS.prev.get(new Date(2026, 8, 20));   // 上月 = 2026-08
  ok('prev range starts at Aug 1', sepWin[0] === new Date(2026, 7, 1).getTime());
  ok('prev range ends at Sep 1 (half-open)', sepWin[1] === new Date(2026, 8, 1).getTime());
  ok('orderInRange excludes the upper bound', orderInRange(new Date(2026, 8, 1).getTime(), sepWin) === false);
  ok('orderInRange includes the lower bound', orderInRange(new Date(2026, 7, 1).getTime(), sepWin) === true);
  ok('orderInRange excludes before the lower bound', orderInRange(new Date(2026, 6, 31).getTime(), sepWin) === false);
  ok('orderInRange accepts Aug 10', orderInRange(new Date(2026, 7, 10).getTime(), sepWin) === true);

  ok('monthLabel formats 2026-09', monthLabel('2026-09') === '2026年9月', 'got=' + monthLabel('2026-09'));
  ok('monthLabel formats 2026-12', monthLabel('2026-12') === '2026年12月', 'got=' + monthLabel('2026-12'));
  ok('rangeLabel(all) is 全部数据', rangeLabel('all') === '全部数据', 'got=' + rangeLabel('all'));
  ok('rangeLabel(month) names the month', rangeLabel('month').indexOf('本月') !== -1, 'got=' + rangeLabel('month'));
  ok('rangeLabel(prev) names the month', rangeLabel('prev').indexOf('上月') !== -1, 'got=' + rangeLabel('prev'));
  ok('statsRange default is all', statsRange === 'all', 'got=' + statsRange);

  // 下拉里的月份是从数据里现推的，且必须倒序（最近的排最前）
  // 这里只需要 city/foodType/platform/date 四个字段，fillFilterOptions 就靠它们建 option
  const mini = (id, ts) => ({ id, date: ts, city: '哈尔滨', foodType: '快餐', platform: '美团' });
  ['#f-month', '#f-city', '#f-food', '#f-channel', '#f-min', '#f-max'].forEach((s) => { getEl(s).value = ''; });
  fillFilterOptions([
    mini('m1', new Date(2026, 8, 10).getTime()),
    mini('m2', new Date(2026, 6, 3).getTime()),
    mini('m3', new Date(2026, 8, 20).getTime()),
  ]);
  // 注意 \\d：TEST 是一整个模板字符串，写 \d 会被当成无效转义、反斜杠被吃掉，
  // 正则就变成 /value="(d{4}-d{2})"/ 永远匹配不到（这个坑本轮真踩了一次）
  const monthOpts = (getEl('#f-month').innerHTML.match(/value="(\\d{4}-\\d{2})"/g) || [])
    .map((s) => s.replace(/value="|"/g, ''));
  ok('fillFilterOptions lists distinct months', monthOpts.length === 2, monthOpts.join(','));
  ok('fillFilterOptions sorts months newest first', monthOpts[0] === '2026-09' && monthOpts[1] === '2026-07',
     monthOpts.join(','));
  ok('month option labels are readable', getEl('#f-month').innerHTML.indexOf('2026年9月') !== -1);
  // 重建 option 会清掉选中值，fillFilterOptions 先存后还才能保住它
  getEl('#f-month').value = '2026-07';
  fillFilterOptions([mini('m4', new Date(2026, 6, 1).getTime())]);   // 数据里还有 2026-07
  ok('month selection survives the option rebuild', getEl('#f-month').value === '2026-07',
     'got=' + JSON.stringify(getEl('#f-month').value));
  getEl('#f-city').value = '哈尔滨';
  getEl('#f-food').value = '快餐';
  fillFilterOptions([mini('m5', new Date(2026, 6, 1).getTime())]);
  ok('city/food selections survive the rebuild too',
     getEl('#f-city').value === '哈尔滨' && getEl('#f-food').value === '快餐',
     'city=' + getEl('#f-city').value + ' food=' + getEl('#f-food').value);
  try {
    fillFilterOptions([]);
    ok('fillFilterOptions([]) does not throw', true);
  } catch (e) { ok('fillFilterOptions([]) does not throw', false, e && e.message); }

  // 月份筛选：先造一组横跨两个月的订单，验证「按月裁订单」而不是「按月筛店铺」
  const mkAt = (id, name, ts, price) => ({
    id, storeKey: name + '|哈尔滨', storeName: name, city: '哈尔滨',
    platform: '美团', foodType: '快餐', channel: '仅外卖', items: '', totalPrice: price,
    people: 1, rating: 5, review: '', dishImage: null, date: ts,
  });
  const cross = [
    mkAt('x1', 'X店', new Date(2026, 8, 10).getTime(), 30),   // 9 月
    mkAt('x2', 'X店', new Date(2026, 7, 10).getTime(), 50),   // 8 月
    mkAt('x3', 'Y店', new Date(2026, 7, 12).getTime(), 20),   // 8 月
  ];
  ['#f-month', '#f-city', '#f-food', '#f-channel', '#f-min', '#f-max'].forEach((s) => { getEl(s).value = ''; });
  getEl('#q').value = '';

  ok('no month filter -> both stores', filterStores(cross).length === 2);
  ok('activeFilterCount is 0 when cleared', activeFilterCount() === 0, 'got=' + activeFilterCount());

  getEl('#f-month').value = '2026-09';
  const sepOnly = filterStores(cross);
  ok('month=2026-09 keeps only X店', sepOnly.length === 1 && sepOnly[0].name === 'X店', 'n=' + sepOnly.length);
  ok('month filter narrows the store order list', sepOnly[0].count === 1 && sepOnly[0].list[0].totalPrice === 30,
     'count=' + (sepOnly[0] && sepOnly[0].count));
  ok('activeFilterCount counts the month', activeFilterCount() === 1, 'got=' + activeFilterCount());

  getEl('#f-month').value = '2026-08';
  const aug = filterStores(cross);
  ok('month=2026-08 keeps both stores', aug.length === 2, 'n=' + aug.length);
  ok('month filter drops Sep orders from the 8 月 view',
     aug.find((s) => s.name === 'X店').count === 1 && aug.find((s) => s.name === 'X店').list[0].totalPrice === 50);
  ok('month + city stack', (function () {
    getEl('#f-city').value = '不存在的城市';
    const n1 = filterStores(cross).length;
    getEl('#f-city').value = '';
    return n1 === 0;
  })());

  // ---- v3.0：店铺 / 地点 / 平台 / 大类 / 小类 是平级的筛选维度 ----
  // 店铺不再是列表的顶层分组，它降级成和其余四个并列的一个筛选项
  // （生鲜/零食那半边压根没有「店铺」这一层）。
  // 先把月份清掉：上面的月份用例故意留了个 2026-08，不清会顺着叠进来。
  getEl('#f-month').value = '';
  ok('按店铺筛选：只留这家店的订单', (function () {
    getEl('#f-store').value = 'X店';
    const n = filterStores(cross);
    getEl('#f-store').value = '';
    return n.length === 1 && n[0].name === 'X店';
  })());
  ok('按平台筛选，与店铺筛选互不干扰', (function () {
    getEl('#f-platform').value = '美团';
    const n = filterStores(cross).length;
    getEl('#f-platform').value = '没有这个平台';
    const m = filterStores(cross).length;
    getEl('#f-platform').value = '';
    return n === 2 && m === 0;
  })());
  ok('筛选是逐单判的：选了大类，组里的订单也跟着裁',
     (function () {
       const mixed = cross.concat([Object.assign({}, mkAt('x4', 'Z店', new Date(2026, 8, 11).getTime(), 40),
         { category: '生鲜', foodType: '苹果', unit: 'jin', people: 2 })]);
       getEl('#f-cat').value = '生鲜';
       const groups = filterStores(mixed);
       getEl('#f-cat').value = '';
       return groups.length === 1 && groups[0].kind === 'food' && groups[0].name === '苹果' &&
         groups[0].count === 1;
     })());
  ok('activeFilterCount 把店铺 / 平台也算进去', (function () {
    getEl('#f-store').value = 'X店';
    getEl('#f-platform').value = '美团';
    const n = activeFilterCount();
    getEl('#f-store').value = '';
    getEl('#f-platform').value = '';
    return n === 2;
  })());
  ok('fillFilterOptions 给店铺和平台建候选', (function () {
    fillFilterOptions(cross);
    return getEl('#f-store').innerHTML.indexOf('value="X店"') !== -1 &&
      getEl('#f-store').innerHTML.indexOf('value="Y店"') !== -1 &&
      getEl('#f-platform').innerHTML.indexOf('value="美团"') !== -1;
  })());

  // 统计页：范围模式与天数窗口互斥
  statsRange = 'month';
  renderStats(orders);
  const mHtml = getEl('#stats-body').innerHTML;
  ok('range card renders 5 presets', (mHtml.match(/data-stats-range=/g) || []).length === 5);
  ok('active range marked on', mHtml.indexOf('class="seg-btn on" data-stats-range="month"') !== -1);
  ok('range mode hides the 7/14/30 window', mHtml.indexOf('data-stats-days=') === -1);
  ok('range mode shows the current range and category scope', mHtml.indexOf('时间：') !== -1 && mHtml.indexOf('大类：') !== -1);
  ok('range mode keeps the day list', (mHtml.match(/day-row/g) || []).length > 0);

  statsRange = 'all';
  renderStats(orders);
  const aHtml = getEl('#stats-body').innerHTML;
  ok('all mode brings the day window back', (aHtml.match(/data-stats-days=/g) || []).length === 3);
  ok('all mode says 全部数据', aHtml.indexOf('全部数据') !== -1);

  // 范围里一单都没有时，选择器必须还在 —— 否则用户会被锁在空页面上
  statsRange = 'month';
  renderStats([mkAt('z1', 'Z店', new Date(2020, 0, 5).getTime(), 10)]);
  const oHtml = getEl('#stats-body').innerHTML;
  ok('empty range still renders the picker', (oHtml.match(/data-stats-range=/g) || []).length === 5);
  ok('empty range tells the user to switch', oHtml.indexOf('换个范围或大类看看') !== -1);
  renderStats([]);
  ok('empty db still renders the picker',
     (getEl('#stats-body').innerHTML.match(/data-stats-range=/g) || []).length === 5);

  statsRange = 'all';
  renderStats(orders);

  // ==== v3.0.3：订单页顶部汇总条 / 大类快捷条 / 已选条件 ====
  // 这一段必须用**派生数据**：原始 orders 里每单都没有 category，catOf 会
  // 一律兜成「餐饮」，拿它测大类筛选等于什么都没测。
  const catOrders = orders.map((o, i) => Object.assign({}, o, {
    category: i % 4 === 0 ? '生鲜' : (i % 4 === 1 ? '零食' : '餐饮'),
  }));
  const resetFilters = () => {
    ['#f-month', '#f-store', '#f-city', '#f-platform', '#f-cat', '#f-food',
      '#f-channel', '#f-min', '#f-max'].forEach((s) => { getEl(s).value = ''; });
    getEl('#q').value = '';
  };

  resetFilters();
  renderStores(catOrders);
  const expTotal = catOrders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
  const expStores = new Set(catOrders.map(orderKeyOf).filter(Boolean)).size;
  ok('汇总条：合计 / 单数 / 家店 与全部订单一致',
     getEl('#sum-total').textContent === '¥' + expTotal.toFixed(0) &&
     getEl('#sum-count').textContent === String(catOrders.length) &&
     getEl('#sum-store').textContent === String(expStores),
     [getEl('#sum-total').textContent, getEl('#sum-count').textContent,
      getEl('#sum-store').textContent, expStores].join('/'));

  const freshN = catOrders.filter((o) => catOf(o) === '生鲜').length;
  getEl('#f-cat').value = '生鲜';
  renderStores(catOrders);
  ok('汇总条跟着筛选走：选了大类就只算这一类的单',
     getEl('#sum-count').textContent === String(freshN), getEl('#sum-count').textContent + ' vs ' + freshN);

  ok('没有筛选条件时「已选条件」整行收起',
     getEl('#filter-chips').hidden === true && getEl('#filter-chips').innerHTML === '');

  getEl('#f-platform').value = '美团';
  renderStores(catOrders);
  const chipHtml = getEl('#filter-chips').innerHTML;
  ok('有筛选条件时渲染成可点掉的标签，且隐藏态解除',
     getEl('#filter-chips').hidden === false && chipHtml.indexOf('平台：美团') !== -1, chipHtml);
  // 大类有自己的常驻入口（快捷条），chips 里再来一条是重复
  ok('已选条件不重复列大类', chipHtml.indexOf('大类：') === -1, chipHtml);

  resetFilters();
  getEl('#f-min').value = '50';
  renderStores(catOrders);
  ok('均价区间也成为一条标签（两个输入框合成一个出口）',
     getEl('#filter-chips').innerHTML.indexOf('#f-price') !== -1,
     getEl('#filter-chips').innerHTML);
  resetFilters();

  // ==== v3.2.0：订单页筛选条优化（控件排状态 + 「更多筛选」低频层）====
  // 新元素 #filter-n / #filter-clear / #more-toggle / #filter-more / #filter-caret
  // 由桩的 getEl 自动建（有 textContent / hidden / click），无需单独打桩。
  // 注意：#filter-panel / #filter-more 的 hidden 在桩里默认是 false（展开态），
  // 这几条看的是「面板收起」时的控件排状态，所以先显式把它俩收起。
  getEl('#filter-panel').hidden = true;
  getEl('#filter-more').hidden = true;
  renderStores(catOrders);
  ok('无筛选时：计数位收起 + 箭头朝下 + 清除按钮隐藏',
     getEl('#filter-n').hidden === true && getEl('#filter-caret').textContent === ' ▾' &&
     getEl('#filter-clear').hidden === true);
  ok('无筛选时「更多筛选」按钮不带徽标', getEl('#more-toggle').textContent === '更多筛选 ▾');

  getEl('#f-platform').value = '美团';
  renderStores(catOrders);
  ok('有筛选时：计数位露出并写条数',
     getEl('#filter-n').hidden === false && getEl('#filter-n').textContent === ' · 1');
  ok('有筛选时「清除筛选」按钮出现', getEl('#filter-clear').hidden === false);
  ok('「更多筛选」带徽标（收起也看得到里面筛了什么）',
     getEl('#more-toggle').textContent === '更多筛选 ·1 ▾');
  ok('filterCount 与旧的 activeFilterCount 同口径',
     filterCount() === activeFilterCount() && filterCount() === 1,
     'fc=' + filterCount() + ' afc=' + activeFilterCount());
  ok('moreFilterCount 只数收进低频层的那几维', moreFilterCount() === 1, 'm=' + moreFilterCount());
  ok('已选条件末尾补一枚「清除全部」chip',
     getEl('#filter-chips').innerHTML.indexOf('#f-all') !== -1);

  resetFilters();
  getEl('#filter-panel').hidden = true;
  renderStores(catOrders);
  ok('清空后计数位与清除按钮一起收回',
     getEl('#filter-n').hidden === true && getEl('#filter-clear').hidden === true);
  ok('无条件时不摆「清除全部」chip（整行也收起）',
     getEl('#filter-chips').hidden === true &&
     getEl('#filter-chips').innerHTML.indexOf('#f-all') === -1);

  // 大类也要算一项：点了快捷条不能显示「0 项」
  getEl('#f-cat').value = '生鲜';
  renderStores(catOrders);
  ok('filterCount 把大类也算一项（否则点快捷条显示 0 项）', filterCount() === 1, 'n=' + filterCount());

  // 面板开合箭头：renderFilterBar 读的是 #filter-panel.hidden
  getEl('#filter-panel').hidden = false;
  renderFilterBar();
  ok('面板展开时箭头朝上', getEl('#filter-caret').textContent === ' ▴');

  getEl('#filter-panel').hidden = true;
  getEl('#filter-more').hidden = true;
  resetFilters();
  renderStores(catOrders);

  // ==== v3.0.3：统计页分区导航 + 大类口径 ====
  statsCat = '';
  renderStats(catOrders);
  const secHtml = getEl('#stats-body').innerHTML;
  ok('统计页内容按四个分区包起来（概览 / 店铺 / 时间 / 分布）',
     ['sec-overview', 'sec-store', 'sec-time', 'sec-dist']
       .every((id) => secHtml.indexOf('id="' + id + '"') !== -1));
  ok('大类选择器常驻：全部 + 三个大类', (secHtml.match(/data-stats-cat=/g) || []).length === 4);
  ok('全部口径下仍是「按大类分开统计」',
     secHtml.indexOf('按大类分开统计') !== -1 && secHtml.indexOf('按小类分开统计') === -1);

  statsCat = '生鲜';
  renderStats(catOrders);
  const freshHtml = getEl('#stats-body').innerHTML;
  ok('切到大类后订单数只算这一类',
     freshHtml.indexOf('>' + freshN + '</b><span>订单数</span>') !== -1, 'n=' + freshN);
  ok('切到大类后自动换成「按小类分开统计」',
     freshHtml.indexOf('生鲜 · 按小类分开统计') !== -1 &&
     freshHtml.indexOf('按大类分开统计') === -1);
  ok('标题里同时写出时间与大类两个口径',
     freshHtml.indexOf('生鲜') !== -1 && freshHtml.indexOf('时间：') !== -1);

  // 小类分解本身：没填小类的单子要单独成一桶，不能摊到某个具体小类上
  const subRows = [
    { id: 'x1', storeName: 'X', category: '生鲜', foodType: '', totalPrice: 10, unit: 'jin', people: 1, rating: 5, date: now },
    { id: 'x2', storeName: 'X', category: '生鲜', foodType: '苹果', totalPrice: 20, unit: 'jin', people: 2, rating: 5, date: now },
    { id: 'x3', storeName: 'Y', category: '生鲜', foodType: '苹果', totalPrice: 30, unit: 'jin', people: 3, rating: 4, date: now },
  ];
  const subHtml = subCategoryStatsCard(subRows, '生鲜', subRows.length);
  ok('小类分解：没填小类的单独成一桶', subHtml.indexOf('小类未填') !== -1 && subHtml.indexOf('苹果') !== -1);
  ok('小类分解按单数从多到少排', subHtml.indexOf('苹果') < subHtml.indexOf('小类未填'));
  ok('categoryStatsCard 传了大类就走小类分解',
     categoryStatsCard(subRows, 3, '生鲜') === subHtml &&
     categoryStatsCard(subRows, 3) !== subHtml);

  statsCat = '';
  renderStats(catOrders);
  ok('切回「全部」恢复横向对比', getEl('#stats-body').innerHTML.indexOf('按大类分开统计') !== -1);

  // 店铺卡片渲染
  try {
    const html = storeCard(B);
    ok('storeCard renders weighted score', html.indexOf('加权评分') !== -1);
    ok('storeCard renders raw avg stat', html.indexOf('原始均分') !== -1);
    ok('storeCard has delete-store button', html.indexOf('data-delstore') !== -1);
    ok('storeCard marks images zoomable', html.indexOf('zoomable') !== -1);
    ok('storeCard has both action buttons', html.indexOf('class="toggle"') !== -1 && html.indexOf('store-del') !== -1);
  } catch (e) { ok('storeCard renders', false, e && e.message); }

  // ---- v3.0：列表页分组（餐饮按店铺，生鲜 / 零食按小类） ----
  // 需求原话：「餐饮之外的品类，订单按小类分，不按照店铺分类」。
  // 买菜买零食时「从哪家店买的」几乎不重要，回头查账想看的轴是「买了什么」；
  // 吃饭时一家店才是有意义的单位。
  const mealO = {
    id: 'g1', storeKey: '饭馆|哈尔滨', storeName: '饭馆', city: '哈尔滨', category: '餐饮',
    platform: '美团', foodType: '快餐', channel: '仅外卖', items: '盖饭', totalPrice: 25,
    people: 1, rating: 5, review: '', dishImage: null, date: now,
  };
  const freshO = {
    id: 'g2', storeKey: '盒马|哈尔滨', storeName: '盒马', city: '哈尔滨', category: '生鲜',
    platform: '盒马', foodType: '苹果', channel: '自提', items: '苹果 2 斤', totalPrice: 20,
    people: 2, unit: 'jin', rating: 4, review: '', dishImage: null, date: now - DAY,
  };
  // 同一个「小类」来自另一家店 —— 这就是为什么生鲜不该按店铺分组
  const freshO2 = Object.assign({}, freshO, {
    id: 'g3', storeKey: '永辉|哈尔滨', storeName: '永辉', platform: '到店',
    totalPrice: 30, rating: 5, date: now - 2 * DAY,
  });
  // 没有 category 的老订单一律算餐饮 → 落进店铺组（老数据不迁移的全部秘密）
  const legacyO = {
    id: 'g4', storeKey: '老饭馆|', storeName: '老饭馆', city: '', foodType: '面',
    platform: '', channel: '仅外卖', items: '', totalPrice: 15, people: 1, rating: 4,
    review: '', dishImage: null, date: now - 3 * DAY,
  };
  const mixedO = [mealO, freshO, freshO2, legacyO];
  const gs = buildGroups(mixedO);
  ok('餐饮订单按店铺成组',
     (function () { const g = gs.filter((x) => x.name === '饭馆')[0]; return !!g && g.kind === 'store'; })());
  ok('没有 category 的老订单也按餐饮 → 店铺成组',
     (function () { const g = gs.filter((x) => x.name === '老饭馆')[0]; return !!g && g.kind === 'store'; })());
  const appleG = gs.filter((x) => x.kind === 'food')[0];
  ok('生鲜订单按小类成组，跨店铺合并成一组',
     !!appleG && appleG.name === '苹果' && appleG.count === 2,
     appleG ? appleG.name + '/' + appleG.count : 'missing');
  ok('小类组的组键带 food: 前缀，不会和 storeKey 撞上', appleG.key === 'food:苹果', appleG.key);
  ok('小类组记住了来源店铺（去重后都在）',
     appleG.storeSources.map((s) => s.name).join('/') === '盒马/永辉',
     appleG.storeSources.map((s) => s.name).join('/'));
  ok('小类组的指标是跨店合并算的',
     Math.abs(appleG.avgPrice - 25) < 1e-9 && Math.abs(appleG.avgRating - 4.5) < 1e-9,
     appleG.avgPrice + '/' + appleG.avgRating);
  ok('分组不改变订单总数', gs.reduce((s, g) => s + g.count, 0) === mixedO.length);
  ok('小类没填的非餐饮订单归到「小类未填」，不塞进别的小类', (function () {
    const g = buildGroups([Object.assign({}, freshO, { id: 'g5', foodType: '' })]);
    return g.length === 1 && g[0].kind === 'food' && g[0].name === '小类未填';
  })());
  ok('buildGroups([]) returns an empty list', buildGroups([]).length === 0);

  try {
    const fh = foodCard(appleG);
    ok('小类卡片带「删除整组」钩子', fh.indexOf('data-delgroup="food:苹果"') !== -1);
    ok('小类卡片给的是同一套加权评分口径', fh.indexOf('加权评分') !== -1);
    ok('每一笔订单都带店名（卡片头没有店名，不带就查不到在哪买的）',
       fh.indexOf('· 永辉 · 到店') !== -1, fh.split('review-meta')[1]);
    ok('小类卡片按来源店铺分别给出整体评价入口',
       fh.indexOf('＋ 写「盒马」的整体评价') !== -1 &&
       fh.indexOf('＋ 写「永辉」的整体评价') !== -1,
       fh);
    // v3.0.1：卡片上多了一层——**小类自己**的评价，键就是组键，
    // 所以卡片拿着 g.key 就能直接读写，不需要任何映射
    ok('小类卡片另外挂着「小类评价」那一块',
       fh.indexOf('data-noteedit="food:苹果"') !== -1, fh);
    ok('小类卡片不带「删除整店」（组是虚拟的，没有整店可删）',
       fh.indexOf('data-delstore') === -1);
    ok('groupCard 按类型分发到对应的卡片', groupCard(appleG).indexOf('food-group') !== -1 &&
       groupCard(B).indexOf('data-delstore') !== -1);
  } catch (e) { ok('foodCard renders', false, e && e.message); }

  // ---- v2.4：页内历史标签（替代原生 datalist）+ 可改的下单日期 ----
  // 历史值按使用次数排序，不按拼音：常用的排前面才有意义
  const hist = historyOf([{ city: '哈尔滨' }, { city: '哈尔滨' }, { city: '秦皇岛' }], 'city');
  ok('historyOf dedupes and puts the most-used first', hist.length === 2 && hist[0] === '哈尔滨', hist.join('/'));
  ok('historyOf drops blank values', historyOf([{ city: '' }, { city: '   ' }], 'city').length === 0);

  refreshHistory(orders);
  ok('refreshHistory rebuilds all three keys',
     histValues.city.length === 1 && histValues.platform.length === 2 && histValues.foodType.length === 2,
     'city=' + histValues.city.length + ' plat=' + histValues.platform.length + ' food=' + histValues.foodType.length);

  getEl('#city').value = '';
  renderSuggest('city', 'city');
  const cityBox = getEl('#sug-city');
  ok('renderSuggest lists history when the input is empty', cityBox.innerHTML.indexOf('哈尔滨') !== -1);
  ok('renderSuggest tags chips with their target input and value',
     cityBox.innerHTML.indexOf('data-sug-for="city"') !== -1 &&
     cityBox.innerHTML.indexOf('data-sug-value="哈尔滨"') !== -1);
  ok('renderSuggest unhides the box when it has candidates', cityBox.hidden === false);

  // 边打边筛：只留包含已输入内容的候选
  getEl('#platform').value = '美';
  renderSuggest('platform', 'platform');
  ok('renderSuggest filters by the typed text',
     getEl('#sug-platform').innerHTML.indexOf('美团') !== -1 &&
     getEl('#sug-platform').innerHTML.indexOf('饿了么') === -1,
     getEl('#sug-platform').innerHTML);

  // 已打完的值不再重复出现（点了等于没点）—— 但 v2.5 起改成**高亮**而不是藏起来。
  // 原因：消费方式默认预填「仅外卖」，藏掉它就等于候选区一个都不剩，
  // 用户想改成堂食反而找不到入口。
  getEl('#platform').value = '美团';
  renderSuggest('platform', 'platform');
  ok('renderSuggest marks the exact match as active instead of hiding it',
     getEl('#sug-platform').innerHTML.indexOf('class="sug-chip on" data-sug-for="platform" data-sug-value="美团"') !== -1,
     getEl('#sug-platform').innerHTML);
  // 候选真的为空时仍然要收起来
  getEl('#platform').value = 'zzz一个不存在的值';
  renderSuggest('platform', 'platform');
  ok('renderSuggest hides the box when nothing is left', getEl('#sug-platform').hidden === true);
  getEl('#platform').value = '';

  // 候选封顶，否则种类一多会把表单顶得老长
  ok('renderSuggest caps the chip count at SUGG_MAX', (function () {
    refreshHistory(Array.from({ length: 30 }, (_, i) => ({ city: 'C' + i, platform: '', foodType: '' })));
    getEl('#city').value = '';
    renderSuggest('city', 'city');
    const n = (getEl('#sug-city').innerHTML.match(/sug-chip/g) || []).length;
    refreshHistory(orders);   // 还原，后面的断言还要用真实数据
    return n === SUGG_MAX;
  })());

  // 日期快捷标签
  ok('dayOffsetValue(0) is today', dayOffsetValue(0) === dayKey(now), dayOffsetValue(0) + ' vs ' + dayKey(now));
  ok('dayOffsetValue(1) is yesterday', dayOffsetValue(1) === dayKey(now - DAY));
  ok('dayOffsetValue(2) is the day before', dayOffsetValue(2) === dayKey(now - 2 * DAY));
  getEl('#orderDate').value = dayKey(now);
  renderDateQuick();
  const dq = getEl('#sug-date').innerHTML;
  ok('renderDateQuick renders 3 quick chips', (dq.match(/sug-chip/g) || []).length === 3, dq);
  ok('renderDateQuick marks today as active', dq.indexOf('class="sug-chip on"') !== -1 && dq.indexOf('>今天<') !== -1);
  ok('renderDateQuick gives 昨天 the right date value', dq.indexOf('data-sug-value="' + dayKey(now - DAY) + '"') !== -1);
  getEl('#orderDate').value = dayKey(now - DAY);
  renderDateQuick();
  ok('renderDateQuick moves the highlight to 昨天',
     getEl('#sug-date').innerHTML.indexOf('class="sug-chip on" data-sug-for="orderDate" data-sug-value="' +
       dayKey(now - DAY) + '"') !== -1);

  // 日期 → 时间戳
  const base = new Date(2026, 8, 20, 13, 45, 30).getTime();
  const shifted = dayValueToTs('2026-09-10', base);
  const sd = new Date(shifted);
  ok('dayValueToTs keeps the chosen date part',
     sd.getFullYear() === 2026 && sd.getMonth() === 8 && sd.getDate() === 10, sd.toString());
  // 选过去的日期时沿用当前钟点，否则同一天的订单会全挤在 00:00
  ok('dayValueToTs keeps the time-of-day of the base moment',
     sd.getHours() === 13 && sd.getMinutes() === 45, sd.toString());
  ok('dayValueToTs accepts unpadded input', new Date(dayValueToTs('2026-9-5', base)).getDate() === 5);
  ok('dayValueToTs rejects garbage', dayValueToTs('明天', base) === null && dayValueToTs('', base) === null);
  ok('dayValueToTs rejects Apr 31', dayValueToTs('2026-04-31', base) === null);
  ok('dayValueToTs rejects Feb 30', dayValueToTs('2026-02-30', base) === null);
  ok('dayValueToTs accepts Feb 29 in a leap year', dayValueToTs('2024-02-29', base) !== null);
  ok('a back-dated order sorts before today',
     dayValueToTs('2026-09-10', base) < dayValueToTs('2026-09-20', base));

  // 表单读写：日期必须默认今天；老草稿里没有 orderDate 也不能变成空
  resetForm();
  ok('resetForm restores today', getEl('#orderDate').value === dayKey(now), getEl('#orderDate').value);
  writeForm({ storeName: 'X', city: '哈尔滨' });
  ok('writeForm falls back to today for legacy drafts',
     getEl('#orderDate').value === dayKey(now), getEl('#orderDate').value);
  writeForm({ storeName: 'X', city: '哈尔滨', orderDate: '2026-08-01' });
  ok('writeForm honours an explicit orderDate', getEl('#orderDate').value === '2026-08-01', getEl('#orderDate').value);
  getEl('#orderDate').value = '2026-08-02';
  ok('readForm carries orderDate', readForm().orderDate === '2026-08-02', readForm().orderDate);
  resetForm();

  // ---- v2.5：字段预置标签 / 消费方式改自由输入 ----
  // ---- v2.5.1：类型去掉预置值，只剩历史值 ----
  // ---- v2.7.2：消费方式的预置标签也取消 ----
  // ---- v2.9：小类的预置也取消 —— 四格彻底同构，候选只有历史值 ----

  refreshHistory([]);
  ok('refreshHistory([]) empties every history bucket',
     histValues.foodType.length === 0 && histValues.platform.length === 0 && histValues.city.length === 0);
  // v3.0.1：消费方式**又回到历史候选**了。生鲜/零食的单可以不填店名，
  // 那时没有店铺清单可依，那一格退回自由输入 + 历史候选（和地点/平台/小类同构）。
  // 注意它的容器是 #sug-channel-text —— #sug-channel 是更早那版自由输入的 id，
  // channel 这个 id 现在归下拉，别照名字猜。
  ok('消费方式重新参与历史候选（HIST_FIELDS 是四格）',
     HIST_FIELDS.join(',') === 'city,platform,channel,foodType' && Array.isArray(histValues.channel),
     HIST_FIELDS.join(',') + ' ch=' + String(histValues.channel));
  // 一次都没打过的时候**一个候选都不该有**：v2.9 起小类不摆任何预置词条了，
  // 空历史 + 空输入 = 空候选，标签行得收起来（留个空框看着像加载失败）。
  setFormCategory('餐饮', false);
  getEl('#foodType').value = '';
  renderSuggest('foodType', 'foodType');
  const ftBox = getEl('#sug-foodType');
  ok('一次都没打过的小类没有任何候选（预置已取消）', ftBox.innerHTML === '', ftBox.innerHTML);
  ok('小类没有候选时标签行是收起的', ftBox.hidden === true);
  ok('小类里再也冒不出预置词（早餐 / 下午茶这类常量）',
     ftBox.innerHTML.indexOf('早餐') === -1 && ftBox.innerHTML.indexOf('下午茶') === -1,
     ftBox.innerHTML);
  // 自己打过的值是**唯一**的候选来源，所以点选 / 排序 / 边打边筛三条都必须成立
  refreshHistory([{ foodType: '麻辣烫' }, { foodType: '麻辣烫' }, { foodType: '日料' }]);
  getEl('#foodType').value = '';
  renderSuggest('foodType', 'foodType');
  ok('小类 keeps its own typed values selectable',
     ftBox.innerHTML.indexOf('data-sug-value="麻辣烫"') !== -1 &&
     ftBox.innerHTML.indexOf('data-sug-value="日料"') !== -1, ftBox.innerHTML);
  ok('小类 sorts its chips by usage count, not by alphabet',
     ftBox.innerHTML.indexOf('麻辣烫') < ftBox.innerHTML.indexOf('日料'), ftBox.innerHTML);
  ok('小类有历史值时标签行自动展开', ftBox.hidden === false);
  getEl('#foodType').value = '麻';
  renderSuggest('foodType', 'foodType');
  ok('小类 history values are still filtered while typing',
     ftBox.innerHTML.indexOf('麻辣烫') !== -1 && ftBox.innerHTML.indexOf('日料') === -1, ftBox.innerHTML);
  getEl('#foodType').value = '';
  renderSuggest('foodType', 'foodType');

  // ---- v3.0：店铺「支持的消费方式」（v3.0.2 起由实际消费方式**沉淀**而来）----
  // v3.0 那版它是「实际消费方式」的前置闸门：得先配好清单，后面那格才有值可选。
  // v3.0.2 把方向反了过来 —— 录入顺序是先填实际消费方式、后填店铺，那时清单还不存在，
  // 让清单当闸门只会把人卡在「请先添加支持的消费方式」上。现在它记的是
  // 「这家店能怎么吃」：从实际消费方式沉淀，也可以手动增删。
  indexMeta([]);        // 没有任何已保存的店铺配置
  _lastOrders = [];     // 也没有历史订单
  resetForm();
  getEl('#storeName').value = '新店';
  getEl('#city').value = '';
  ok('没有已保存配置时清单是空的', supChannels.length === 0, supChannels.join('/'));
  ok('清单为空也不拦着填实际消费方式（它不再是闸门，输入框永远可用）',
     getEl('#channel-text').disabled === false);
  addSupChannel('仅外卖');
  ok('加第一个支持项', supChannels.join('/') === '仅外卖', supChannels.join('/'));
  addSupChannel('堂食');
  ok('第二个支持项也进得去', supChannels.join('/') === '仅外卖/堂食', supChannels.join('/'));
  ok('加支持项不会顺手改掉用户填着的实际消费方式', (function () {
    setChannel('自提');
    addSupChannel('拼单');
    return readChannel() === '自提';
  })(), readChannel());
  ok('支持项去重：同样的值加两次还是一项', (function () {
    const before = supChannels.length;
    addSupChannel('堂食');
    return supChannels.length === before;
  })());
  ok('空值 / 纯空格不会被当成一个支持项', (function () {
    const before = supChannels.length;
    addSupChannel('   ');
    addSupChannel('');
    return supChannels.length === before;
  })());
  ok('已选标签带的是删除钩子，不是点击填充', (function () {
    renderSupChannels();
    const h = getEl('#sup-channel-box').innerHTML;
    return h.indexOf('class="sup-chip"') !== -1 && h.indexOf('data-supdel="仅外卖"') !== -1;
  })(), getEl('#sup-channel-box').innerHTML);
  removeSupChannel('仅外卖');
  ok('删掉一个支持项', supChannels.join('/') === '堂食/拼单', supChannels.join('/'));
  ok('删支持项也不动实际消费方式', readChannel() === '自提', readChannel());

  // channelsOfStore：已保存的配置 ∪ 该店历史订单里用过的值（去重、保序、只认这家店）。
  // 老键「店名|地点」在 indexMeta 里被归一到纯店名，查表时也用归一后的键。
  indexMeta([{ storeKey: '老店|哈尔滨', channels: ['仅外卖', '自提'] }]);
  _lastOrders = [
    { id: 'h1', storeKey: '老店|哈尔滨', storeName: '老店', city: '哈尔滨', channel: '自提' },
    { id: 'h2', storeKey: '老店|哈尔滨', storeName: '老店', city: '哈尔滨', channel: '堂食' },
    { id: 'h3', storeKey: '别的店|哈尔滨', storeName: '别的店', city: '哈尔滨', channel: '外带' },
  ];
  ok('支持清单 = 已保存配置 ∪ 该店历史里用过的值，别人家的不跟过来',
     channelsOfStore('老店|哈尔滨').join('/') === '仅外卖/自提/堂食',
     channelsOfStore('老店|哈尔滨').join('/'));
  ok('没有配置也没有历史的店拿到空清单',
     channelsOfStore('从没见过的店|').length === 0);

  // 回填：老订单的 channel 必须原样带回来，否则一保存就把值吃掉
  writeForm({ storeName: '老店', city: '哈尔滨', channel: '堂食', foodType: '快餐',
              totalPrice: '30', people: '1', rating: '5', orderDate: '2026-09-20' });
  ok('编辑旧单时它原先的消费方式还在输入框里',
     readChannel() === '堂食', readChannel());
  ok('编辑旧单时它原先的消费方式也在该店清单里',
     supChannels.indexOf('堂食') !== -1, supChannels.join('/'));
  writeForm({ storeName: '某店', city: '', channel: '打包带走', foodType: '快餐',
              totalPrice: '30', people: '1', rating: '5', orderDate: '2026-09-20' });
  ok('老单里那个从没配过的值会被补进清单，而不是凭空丢掉',
     supChannels[0] === '打包带走' && readChannel() === '打包带走',
     supChannels.join('/') + ' -> ' + readChannel());
  writeForm({ storeName: '老店', city: '哈尔滨', channel: '自提',
              supportedChannels: ['自提', '拼单'], foodType: '快餐',
              totalPrice: '30', people: '1', rating: '5', orderDate: '2026-09-20' });
  ok('草稿里那份支持清单优先于历史值（用户加了还没保存的项不能丢）',
     supChannels.join('/') === '自提/拼单' && readChannel() === '自提',
     supChannels.join('/') + ' -> ' + readChannel());
  getEl('#storeName').value = '老店';
  getEl('#city').value = '哈尔滨';
  loadSupForStore(true);
  ok('换回另一家店时清单整个换掉（地点已不参与身份，老键照样命中）',
     supChannels.join('/') === '仅外卖/自提/堂食', supChannels.join('/'));
  resetForm();
  ok('重置表单会把支持清单一起清空（它是店铺级的，不该留到下一张单）',
     supChannels.length === 0 && readChannel() === '',
     supChannels.join('/') + ' -> ' + readChannel());
  indexMeta([]);
  _lastOrders = [];
  refreshHistory(orders);

  // ---- v3.0.2：店名完全选填 / 实际消费方式单一形态 / 店铺清单由实际消费方式沉淀 ----
  // 四条新规矩：
  //   ① **店铺名称完全选填**（餐饮也不再强制）—— 没店名就没有「店铺」这层归属
  //   ② 没店名 → 「支持的消费方式」整块收起（它是**店铺属性**，挂在 storeKey 上）
  //   ③ 实际消费方式只有**一种形态**（自由输入 + 历史候选），填的值沉淀进该店清单
  //   ④ 实际消费方式是「线下」时不显示「平台」
  indexMeta([]);
  _lastOrders = [];
  resetForm();

  // ① 店名选填，星号恒隐藏 —— 嘴上说选填、界面还挂着星等于骗人
  setFormCategory('餐饮', false);
  ok('餐饮：店名也不再必填', getEl('#storeName').required === false);
  ok('餐饮：星号也藏起来了', getEl('#store-req').hidden === true);
  setFormCategory('生鲜', false);
  ok('生鲜：店名同样是选填', getEl('#storeName').required === false);
  ok('生鲜：星号同样藏起来', getEl('#store-req').hidden === true);

  // ② 支持块跟着店名走
  getEl('#storeName').value = '';
  applyFormMode();
  ok('没店名：支持块整块收起（店铺属性没有载体）', getEl('#sup-field').hidden === true);
  getEl('#storeName').value = '盒马鲜生';
  applyFormMode();
  ok('填了店名：支持块出现', getEl('#sup-field').hidden === false);

  // ③ 实际消费方式只有一种形态：读写的都是那个输入框
  setChannel('自提');
  ok('readChannel 读的就是输入框里的值', readChannel() === '自提', readChannel());
  ok('写进去的也在同一个框里', getEl('#channel-text').value === '自提', getEl('#channel-text').value);

  // ④ 平台只在「实际消费方式」不是「线下」时出现
  getEl('#storeName').value = '';
  setChannel('仅外卖');
  applyFormMode();
  ok('实际消费方式不是线下：平台那格显示', getEl('#platform-field').hidden === false);
  setChannel('线下');
  applyFormMode();
  ok('实际消费方式是「线下」：平台那格收起', getEl('#platform-field').hidden === true);
  setChannel('堂食');
  applyFormMode();
  ok('「堂食」不算线下（判据精确相等，不模糊匹配）', getEl('#platform-field').hidden === false);

  // ⑤ 实际消费方式填了就沉淀进该店清单（v3.0.2 的核心关系）
  getEl('#storeName').value = '盒马鲜生';
  applyFormMode();
  setChannel('自提');
  ok('沉淀前清单里没有「自提」', supChannels.indexOf('自提') === -1, supChannels.join('/'));
  ok('absorbChannelIntoStore 返回 true 表示清单变了', absorbChannelIntoStore() === true);
  ok('沉淀后清单里就有它了', supChannels.indexOf('自提') !== -1, supChannels.join('/'));
  ok('再沉淀一次不重复加', absorbChannelIntoStore() === false);
  getEl('#storeName').value = '';
  ok('没店名时不沉淀（清单是店铺属性，没有载体）', absorbChannelIntoStore() === false);

  // ⑥ 换店时用户当前填着的值不能被覆盖掉（v3.0.1 的 E-03 回归）
  getEl('#storeName').value = '永辉超市';
  setChannel('配送到家');
  loadSupForStore(true);
  ok('换店加载清单时保住了用户当前填的值',
     supChannels.indexOf('配送到家') !== -1, supChannels.join('/'));

  // ⑦ 店铺身份：v3.0.2 起只看店名
  ok('storeKeyOf 只看店名且会 trim',
     storeKeyOf('麦当劳') === '麦当劳' && storeKeyOf(' 麦当劳 ') === '麦当劳');
  ok('normStoreKey 把老键切成纯店名，对新键是幂等的',
     normStoreKey('麦当劳|哈尔滨') === '麦当劳' && normStoreKey('麦当劳') === '麦当劳');
  ok('orderKeyOf 对老订单（店名|城市）也能读出店名',
     orderKeyOf({ storeKey: '麦当劳|哈尔滨' }) === '麦当劳' &&
     orderKeyOf({ storeName: '麦当劳' }) === '麦当劳' &&
     orderKeyOf({}) === '');

  // storeMeta 混着两种归属，遍历时必须能分开。归属判据是**行上的 kind**（v3.0.2 起），
  // 老行才退回首前缀；老键「店名|地点」在 indexMeta 里统一归一。
  // （注意：TEST 整段是模板字符串，这里不能出现反引号，会当场闭合它。）
  indexMeta([
    { storeKey: '盒马鲜生|哈尔滨', note: '菜新鲜', channels: ['配送到家'] },
    { storeKey: 'food:苹果', note: '脆，但放两天就面' },
  ]);
  ok('老键（店名|地点）被归一到纯店名',
     Object.keys(storeMeta).join('/') === '盒马鲜生/food:苹果', Object.keys(storeMeta).join('/'));
  ok('归一之后旧键进了待清理列表（交给 migrateMetaKeys 删）',
     staleMetaKeys.join('/') === '盒马鲜生|哈尔滨', staleMetaKeys.join('/'));
  ok('storeMetaRows 只取店铺那批（food: 那行不算店铺）',
     storeMetaRows('store').length === 1 && storeMetaRows('store')[0].storeKey === '盒马鲜生',
     storeMetaRows('store').map((m) => m.storeKey).join('/'));
  ok('storeMetaRows 能单独取出小类那批',
     storeMetaRows('food').length === 1 && storeMetaRows('food')[0].note === '脆，但放两天就面');
  ok('老行按前缀补上了 kind',
     storeMeta['food:苹果'].kind === 'food' && storeMeta['盒马鲜生'].kind === 'store',
     storeMeta['food:苹果'].kind + '/' + storeMeta['盒马鲜生'].kind);
  ok('一家叫「food:包子」的店铺不会被误判成小类行（归属看 kind，不看前缀）', (function () {
    // indexMeta 会**整份重建** storeMeta，这里必须自己备份再还原 ——
    // 不还原的话后面那几段（小类评价 / 店铺整体评价）会突然读不到数据。
    const backup = Object.keys(storeMeta).map((k) => storeMeta[k]);
    indexMeta([{ storeKey: 'food:包子', kind: 'store', note: '皮薄' }]);
    const r = storeMetaRows('store').length === 1 && storeMetaRows('food').length === 0;
    indexMeta(backup);
    return r;
  })(), storeMetaRows('store').length + '/' + storeMetaRows('food').length);
  ok('isFoodMetaKey 仍然只认前缀（它只用来认「这个键是不是小类键」）',
     isFoodMetaKey('food:苹果') === true && isFoodMetaKey('盒马鲜生') === false);
  ok('没店名的餐饮单归「未命名店铺」组，不是空键', (function () {
    const g = groupOf({ category: '餐饮', storeName: '' });
    return g.kind === 'store' && g.key === '未命名店铺';
  })());
  ok('小类评价的键和列表页的分组键是同一个值',
     groupOf({ category: '生鲜', foodType: '苹果' }).key === FOOD_GROUP_PREFIX + '苹果');

  // 小类评价那格：跟着小类换、餐饮下不出现
  setFormCategory('生鲜', false);
  getEl('#foodType').value = '';
  foodNoteName = ''; foodNoteLoaded = '';
  refreshFoodNote(false);
  ok('没填小类时那格收起', getEl('#food-note-field').hidden === true);
  getEl('#foodType').value = '苹果';
  refreshFoodNote(false);
  ok('填了小类就出现，并把已存的那段读回来',
     getEl('#food-note-field').hidden === false && getEl('#food-note').value === '脆，但放两天就面',
     getEl('#food-note').value);
  ok('换一个小类就读不到了（按小类名分开存）', (function () {
    getEl('#foodType').value = '香蕉';
    refreshFoodNote(false);
    return getEl('#food-note').value === '';
  })(), getEl('#food-note').value);
  ok('餐饮下永远不显示小类评价（小类不是餐饮的分组维度）', (function () {
    getEl('#foodType').value = '快餐';
    setFormCategory('餐饮', false);
    return getEl('#food-note-field').hidden === true;
  })());

  // 脏值判定：「已保存值」必须发生在 await **之前** —— 否则这中间来一次切换，
  // 同一段文字会被再存一遍，顺序再错一点就存到刚切过去的那个小类上了
  setFormCategory('生鲜', false);
  getEl('#foodType').value = '苹果';
  foodNoteName = ''; foodNoteLoaded = '';
  refreshFoodNote(false);
  getEl('#food-note').value = '很脆';
  const noteWrite = saveFoodNoteIfDirty();
  ok('saveFoodNoteIfDirty 在 await 之前就把「已保存值」认下来了',
     foodNoteLoaded === '很脆', foodNoteLoaded);
  ok('它返回 Promise（可以 await，不 await 也不会同步抛错）',
     !!noteWrite && typeof noteWrite.then === 'function');
  ok('没改过时直接返回，不白写一次库', (function () {
    const before = foodNoteLoaded;
    saveFoodNoteIfDirty();
    return foodNoteLoaded === before;
  })());

  // 小类卡片上的那一块（有内容时给的是「编辑」，不是「＋ 写」）
  noteDraft = {}; editingNoteKey = null;
  const appleCard = foodCard(appleG);
  ok('小类卡片渲染小类评价的正文', appleCard.indexOf('脆，但放两天就面') !== -1, appleCard);
  ok('小类评价带 food 修饰类，和店铺评价分层', appleCard.indexOf('store-note food') !== -1);
  ok('小类评价的编辑钩子指向组键', appleCard.indexOf('data-noteedit="food:苹果"') !== -1);
  ok('来源店铺的整体评价入口没被顶掉',
     appleCard.indexOf('＋ 写「盒马」的整体评价') !== -1);
  ok('已有内容时不再显示「＋ 写小类评价」', appleCard.indexOf('＋ 写小类评价') === -1);

  foodNoteName = ''; foodNoteLoaded = '';
  setFormCategory('餐饮', false);
  indexMeta([]);
  _lastOrders = [];
  refreshHistory(orders);

  // ---- v2.6：份数 / 重量双模式 + 分开统计 ----
  // 老数据回归是本组最重要的一条：手机上已有的订单没有 unit 字段，
  // 它们必须被当成份数单。这条挂了 = 老用户的全部数据口径错乱。
  ok('an order without a unit field is treated as 份数',
     isJin({ totalPrice: 30, people: 2 }) === false);
  ok('unit:jin is treated as 重量', isJin({ unit: 'jin' }) === true);
  ok('unit:fen is treated as 份数', isJin({ unit: 'fen' }) === false);
  ok('UNIT constants are fen/jin as the renderer expects',
     UNIT.PIECES === 'fen' && UNIT.WEIGHT === 'jin', UNIT.PIECES + '/' + UNIT.WEIGHT);

  // 每斤均价：2.5 斤这个数是本组的核心 —— parseInt 会把它截成 2，
  // 那正是当初差点写错的地方。
  ok('jin price divides by the fractional weight, not a truncated int',
     Math.abs(jinPrice(88, 2.5) - 35.2) < 1e-9, String(jinPrice(88, 2.5)));
  ok('jin price returns null instead of NaN when the weight is missing',
     jinPrice(88, '') === null && jinPrice(88, 0) === null, String(jinPrice(88, '')));
  ok('jin price is null when the total is missing', jinPrice('', 2.5) === null);

  ok('a 份数 order renders 人均, not 每斤',
     unitPriceText({ totalPrice: 100, people: 2 }) === '人均¥50.0',
     unitPriceText({ totalPrice: 100, people: 2 }));
  ok('a 重量 order renders 每斤, never 人均',
     unitPriceText({ unit: 'jin', totalPrice: 88, people: 2.5 }) === '每斤¥35.2',
     unitPriceText({ unit: 'jin', totalPrice: 88, people: 2.5 }));
  ok('a 重量 order with no weight shows a dash instead of NaN',
     unitPriceText({ unit: 'jin', totalPrice: 88, people: '' }) === '每斤 —',
     unitPriceText({ unit: 'jin', totalPrice: 88, people: '' }));

  ok('qty text uses 斤 for weight orders',
     qtyText({ unit: 'jin', people: 2.5 }) === '2.5斤', qtyText({ unit: 'jin', people: 2.5 }));
  ok('qty text uses 人 for pieces orders',
     qtyText({ people: 2 }) === '2人', qtyText({ people: 2 }));
  ok('qty text drops a meaningless .0 tail',
     qtyText({ unit: 'jin', people: 3 }) === '3斤' && qtyText({ people: 1 }) === '1人',
     qtyText({ unit: 'jin', people: 3 }) + '/' + qtyText({ people: 1 }));

  // splitByUnit 是所有展示口径的唯一来源，这里逐个字段钉住
  const mix = splitByUnit([
    { totalPrice: 100, people: 2 },                      // 份数，人均 50
    { totalPrice: 60, people: 3 },                       // 份数，人均 20
    { unit: 'jin', totalPrice: 50, people: 2 },          // 重量，每斤 25
    { unit: 'jin', totalPrice: 40, people: 2.5 },        // 重量，每斤 16
  ]);
  ok('splitByUnit separates the two buckets by count',
     mix.fen.count === 2 && mix.jin.count === 2,
     'fen=' + mix.fen.count + ' jin=' + mix.jin.count);
  ok('the 份数 bucket computes 人均 = 总额/人数合计',
     Math.abs(mix.fen.perUnit - (160 / 5)) < 1e-9, String(mix.fen.perUnit));
  ok('the 重量 bucket computes 每斤均价 = 总额/斤数合计',
     Math.abs(mix.jin.perUnit - (90 / 4.5)) < 1e-9, String(mix.jin.perUnit));
  ok('the 重量 bucket keeps the total weight it bought',
     Math.abs(mix.jin.sumQty - 4.5) < 1e-9, String(mix.jin.sumQty));
  ok('each bucket has its own average price',
     Math.abs(mix.fen.avgPrice - 80) < 1e-9 && Math.abs(mix.jin.avgPrice - 45) < 1e-9,
     mix.fen.avgPrice + '/' + mix.jin.avgPrice);
  ok('splitByUnit returns null for a mode with no orders',
     splitByUnit([{ totalPrice: 10, people: 1 }]).jin === null);
  ok('the two buckets of money add up to the grand total', (function () {
    // 注意不能用主 orders —— 那批数据全是份数单，jin 桶会是 null
    const both = splitByUnit([
      { totalPrice: 100, people: 2 },
      { unit: 'jin', totalPrice: 90, people: 3 },
    ]);
    return Math.abs(both.fen.sumTotal + both.jin.sumTotal - 190) < 1e-9;
  })(), 'money must be additive even though 人均/每斤 are not');

  // 聚合：groupByStore 必须把两桶都挂出来，并且人均只由份数单算
  const mixed = groupByStore([
    { id: 'm1', storeKey: '混店|哈', storeName: '混店', city: '哈', platform: '', foodType: '',
      channel: '', items: '', totalPrice: 100, people: 2, rating: 5, review: '', dishImage: null, date: now },
    { id: 'm2', storeKey: '混店|哈', storeName: '混店', city: '哈', platform: '', foodType: '',
      channel: '', items: '', totalPrice: 90, people: 3, unit: 'jin', rating: 5, review: '', dishImage: null, date: now },
  ])[0];
  ok('groupByStore keeps a bucket per unit mode',
     mixed.unitParts.fen && mixed.unitParts.jin);
  ok('混店 card shows both 份数 and 重量 rows', (function () {
    const html = storeStatsHtml(mixed);
    return html.indexOf('份数') !== -1 && html.indexOf('重量') !== -1 &&
      html.indexOf('人均') !== -1 && html.indexOf('每斤') !== -1;
  })(), storeStatsHtml(mixed));
  ok('perCapita only divides by the 份数 bucket, never by the 斤 bucket',
     Math.abs(mixed.perCapita - 50) < 1e-9, String(mixed.perCapita));

  // 纯重量的店没有「人均」可言，卡片上不该出现「人均」二字
  const onlyJin = groupByStore([{
    id: 'j1', storeKey: '水果店|哈', storeName: '水果店', city: '哈', platform: '', foodType: '',
    channel: '', items: '', totalPrice: 46, people: 2.5, unit: 'jin', rating: 5, review: '',
    dishImage: null, date: now,
  }])[0];
  ok('a purely 重量 store has no 人均 at all',
     onlyJin.perCapita === null && storeStatsHtml(onlyJin).indexOf('人均') === -1,
     'perCapita=' + onlyJin.perCapita);
  ok('a purely 重量 store still shows its 每斤均价',
     storeStatsHtml(onlyJin).indexOf('每斤 ¥18.4') !== -1, storeStatsHtml(onlyJin));
  ok('a purely 重量 store omits the empty 份数 row',
     storeStatsHtml(onlyJin).indexOf('份数') === -1, storeStatsHtml(onlyJin));

  // ---- v2.7：三个大类（餐饮 / 生鲜 / 零食）----
  // catOf 是「老数据不用迁移」的全部秘密：手机上已有的订单没有 category 字段，
  // 必须被当成「餐饮」。这条挂了 = 老用户的统计口径全变。
  ok('catOf defaults to 餐饮 for orders without a category',
     catOf({}) === '餐饮' && catOf(null) === '餐饮' && catOf(undefined) === '餐饮');
  ok('catOf keeps a valid category', catOf({ category: '生鲜' }) === '生鲜');
  ok('catOf falls back to 餐饮 for a value it cannot recognise',
     catOf({ category: '手改坏的' }) === '餐饮', catOf({ category: '手改坏的' }));
  ok('there are exactly three categories, each with a default unit',
     CATEGORIES.length === 3 && CATEGORIES.every((c) =>
       c.unit === UNIT.PIECES || c.unit === UNIT.WEIGHT));
  ok('餐饮 defaults to 份数 while 生鲜 and 零食 default to 重量',
     categoryDef('餐饮').unit === UNIT.PIECES &&
     categoryDef('生鲜').unit === UNIT.WEIGHT &&
     categoryDef('零食').unit === UNIT.WEIGHT);
  // v2.9：整张词条表删掉。留着的话「小类」那格又会冒出没点过的固定标签，
  // 而且 UI 上看不出来那是预置还是历史 —— 这正是这一版要杜绝的。
  ok('no category carries a preset word list any more（v2.9 取消预置）',
     CATEGORIES.every((c) => c.words === undefined),
     JSON.stringify(CATEGORIES.map((c) => c.name + ':' + (c.words || []).length)));
  ok('categoryDef falls back to the first category', categoryDef('不存在').name === '餐饮');

  // 切换大类：计量方式跟着切 + 小类那一格的候选整组换掉。
  // v2.9 之前这个「整组换」是靠预置词条体现的（餐饮给餐次、生鲜给品类）；
  // 预置取消后只剩历史值那份，所以断言得从数据侧造，不能再指着词条表。
  refreshHistory([
    { category: '餐饮', foodType: '麻辣烫' },
    { category: '生鲜', foodType: '水果' },
    { category: '生鲜', foodType: '水果' },
    { category: '生鲜', foodType: '海鲜' },
  ]);
  setFormCategory('餐饮', false);
  getEl('#foodType').value = '';
  renderSuggest('foodType', 'foodType');
  ok('餐饮类下的小类候选只有餐饮那一份历史值',
     getEl('#sug-foodType').innerHTML.indexOf('data-sug-value="麻辣烫"') !== -1 &&
     getEl('#sug-foodType').innerHTML.indexOf('data-sug-value="水果"') === -1,
     getEl('#sug-foodType').innerHTML);
  setFormCategory('生鲜', true);
  ok('picking 生鲜 switches the unit to 重量', formUnit === UNIT.WEIGHT, formUnit);
  ok('切到生鲜后小类候选整组换成生鲜那一份，餐饮的历史值不跟过来', (function () {
    const html = getEl('#sug-foodType').innerHTML;
    return html.indexOf('data-sug-value="水果"') !== -1 &&
      html.indexOf('data-sug-value="海鲜"') !== -1 &&
      html.indexOf('data-sug-value="麻辣烫"') === -1;
  })(), getEl('#sug-foodType').innerHTML);
  ok('切完大类后小类仍然按「用得多排前面」', (function () {
    const html = getEl('#sug-foodType').innerHTML;
    return html.indexOf('水果') < html.indexOf('海鲜'); // 水果 2 单、海鲜 1 单
  })(), getEl('#sug-foodType').innerHTML);
  ok('picking a 大类 clears the 小类 that was already typed',
     getEl('#foodType').value === '', 'leftover=' + getEl('#foodType').value);
  setFormCategory('餐饮', true);
  ok('picking 餐饮 switches the unit back to 份数', formUnit === UNIT.PIECES, formUnit);
  // 大类只给默认值，模式仍然能手动改 —— 有人按包买零食，锁死会让他录不进去
  setFormCategory('零食', true);
  setFormUnit(UNIT.PIECES, true);
  ok('the unit stays manually overridable after a 大类 switch',
     formUnit === UNIT.PIECES && formCategory === '零食');
  setFormCategory('餐饮', true);

  // ---- v2.7.1：「大类」下面那几格的候选全部按大类分开 ----
  // 混在一起的话，生鲜类下的平台候选里会一直摆着餐饮用的「美团」，
  // 而那一单根本不可能用它。剩下的三格（地点 / 平台 / 小类）一起分开，切大类就整组换。
  // （消费方式 v3.0 已退出这一套 —— 它现在由店铺的支持清单驱动，和大类无关。）
  refreshHistory([
    { category: '餐饮', platform: '美团',     city: '哈尔滨', channel: '仅外卖' },
    { category: '餐饮', platform: '美团',     city: '哈尔滨', channel: '仅外卖' },
    { category: '餐饮', platform: '饿了么',   city: '秦皇岛', channel: '食堂' },
    { category: '生鲜', platform: '盒马',     city: '哈尔滨', channel: '自提' },
    { category: '生鲜', platform: '盒马',     city: '哈尔滨', channel: '自提' },
    { category: '生鲜', platform: '叮咚买菜', city: '哈尔滨', channel: '自提' },
  ]);
  setFormCategory('餐饮', false);
  ok('三格的历史值都按大类分开攒（餐饮那一份）',
     histValues.platform.join('/') === '美团/饿了么' &&
     histValues.city.join('/') === '哈尔滨/秦皇岛',
     'plat=' + histValues.platform.join('/') + ' city=' + histValues.city.join('/'));
  ok('分开攒之后「用得多排前面」照样成立', histValues.platform[0] === '美团',
     histValues.platform.join('/'));

  setFormCategory('生鲜', false);
  ok('切到生鲜后平台 / 地点整组换成生鲜那一份',
     histValues.platform.join('/') === '盒马/叮咚买菜' &&
     histValues.city.join('/') === '哈尔滨',
     'plat=' + histValues.platform.join('/') + ' city=' + histValues.city.join('/'));
  getEl('#platform').value = '';
  renderSuggest('platform', 'platform');
  ok('生鲜类下的平台候选里没有餐饮用过的美团',
     getEl('#sug-platform').innerHTML.indexOf('盒马') !== -1 &&
     getEl('#sug-platform').innerHTML.indexOf('美团') === -1,
     getEl('#sug-platform').innerHTML);

  refreshHistory(orders);
  setFormCategory('餐饮', false);

  // **v2.6 遗留的一个真 bug**：writeForm 先把 people 写成订单里的值，
  // 紧接着 setFormUnit 又无条件把它重置成 ''/'1' —— 于是编辑一条「3 人」的单子
  // 回来人数变成 1，编辑「2.5 斤」的单子回来斤数变空，一保存就把数据改坏了。
  // 现在只有用户主动切换（clearQty=true）才清值，回填路径必须原样留着。
  writeForm({ storeName: 'X', platform: '', category: '餐饮', foodType: '麻辣烫',
              channel: '仅外卖', items: '', totalPrice: '88', people: '3', unit: UNIT.PIECES,
              rating: '5', review: '', orderDate: '2026-09-20' });
  ok('editing a 份数 order keeps its 用餐人数',
     String(getEl('#people').value) === '3', 'people=' + getEl('#people').value);
  writeForm({ storeName: '水果摊', platform: '', category: '生鲜', foodType: '水果',
              channel: '仅外卖', items: '', totalPrice: '46', people: '2.5', unit: UNIT.WEIGHT,
              rating: '5', review: '', orderDate: '2026-09-20' });
  ok('editing a 重量 order keeps its 斤数 (2.5, not 2 and not blank)',
     String(getEl('#people').value) === '2.5', 'people=' + getEl('#people').value);
  ok('editing an order restores its 大类 and 小类 together',
     formCategory === '生鲜' && getEl('#foodType').value === '水果',
     formCategory + '/' + getEl('#foodType').value);
  ok('an order with no category at all refills as 餐饮 + 份数', (function () {
    writeForm({ storeName: 'X', platform: '', foodType: '快餐', channel: '仅外卖',
                items: '', totalPrice: '30', people: '2', rating: '5', review: '',
                orderDate: '2026-09-20' });
    return formCategory === '餐饮' && formUnit === UNIT.PIECES;
  })(), formCategory + '/' + formUnit);

  // 统计页的大类卡：v2.7 起它**取代**了「份数 / 重量分开统计」那张
  // （大类跟单位几乎一一对应，两张卡的数字几乎一样，还容易因为手动改过单位而对不上）
  const catHtml = categoryStatsCard([
    { category: '餐饮', totalPrice: 100, people: 2 },
    { category: '餐饮', totalPrice: 60, people: 3 },
    { category: '生鲜', unit: 'jin', totalPrice: 50, people: 2 },
    { category: '零食', unit: 'jin', totalPrice: 40, people: 2.5 },
  ], 4);
  ok('the stats card lists all three categories',
     catHtml.indexOf('餐饮') !== -1 && catHtml.indexOf('生鲜') !== -1 && catHtml.indexOf('零食') !== -1);
  ok('the stats card gives each category its own row',
     (catHtml.match(/class="us-row"/g) || []).length === 3,
     (catHtml.match(/class="us-row"/g) || []).length + ' rows');
  // 判据必须是 <small>人均</small> 而不是「人均」二字 —— 卡片底部那句提示里
  // 就写着「人均 / 每斤」，拿关键词当判据必然假通过
  ok('餐饮 shows 人均 because all of its orders are 份数',
     catHtml.indexOf('<small>人均</small>') !== -1);
  ok('生鲜 shows 每斤 because all of its orders are 重量',
     catHtml.indexOf('<small>每斤</small>') !== -1);
  ok('a category with no orders gets no row at all', (function () {
    const one = categoryStatsCard([{ category: '零食', unit: 'jin', totalPrice: 10, people: 1 }], 1);
    return (one.match(/class="us-row"/g) || []).length === 1 &&
      one.indexOf('餐饮') === -1 && one.indexOf('生鲜') === -1;
  })());
  ok('a category with mixed units drops 人均/每斤 rather than dividing 斤 by 人', (function () {
    // 餐饮类里混进一笔按斤的单 —— 硬算人均就是把斤数当头数（v2.6 踩过的坑）
    const mixedCat = categoryStatsCard([
      { category: '餐饮', totalPrice: 100, people: 2 },
      { category: '餐饮', unit: 'jin', totalPrice: 90, people: 3 },
    ], 2);
    return mixedCat.indexOf('<small>人均</small>') === -1 &&
      mixedCat.indexOf('<small>每斤</small>') === -1 &&
      (mixedCat.match(/class="us-row"/g) || []).length === 1;
  })());
  ok('orders without a category land in the 餐饮 row', (function () {
    const old = categoryStatsCard([{ totalPrice: 20, people: 1 }], 1);
    return old.indexOf('餐饮') !== -1 && (old.match(/class="us-row"/g) || []).length === 1;
  })());
  ok('categoryStatsCard survives an empty list', categoryStatsCard([], 0) === '');

  // ---- v2.5：地点改选填 ----
  // 注意 looksLikeOrder 返回的是 o.storeName 的原值（字符串），不是严格布尔，
  // 所以这里断言「真值」而不是 === true
  ok('looksLikeOrder no longer needs a city', !!looksLikeOrder({ storeName: 'X' }));
  const noCity = groupByStore([{
    id: 'n1', storeKey: '无地点店|', storeName: '无地点店', city: '',
    platform: '', foodType: '', channel: '', items: '', totalPrice: 20, people: 1,
    rating: 5, review: '', dishImage: null, date: now,
  }]);
  ok('a store with a blank city still groups into one card',
     noCity.length === 1 && noCity[0].cities.length === 0, 'n=' + noCity.length);
  ok('a blank city does not leave a stray separator in the subtitle', (function () {
    const cut = storeCard(noCity[0]).split('<div class="store-sub">')[1];
    const text = cut ? cut.split('</div>')[0] : '<<missing>>';
    return text === '小类未填 · 消费方式未填';
  })(), storeCard(noCity[0]).split('<div class="store-sub">')[1]);

  // ---- v2.5：店铺整体评价（纯文字备注） ----
  // 注意键：老数据是「店名|地点」，indexMeta 会把它归一到纯店名（v3.0.2 起），
  // 所以下面查表 / 断言钩子用的都是归一后的键。
  indexMeta([{ storeKey: 'B店|哈尔滨', note: '出餐快，环境一般', updatedAt: 1 }]);
  ok('indexMeta builds a storeKey -> row map',
     !!storeMeta['B店'] && storeMeta['B店'].note === '出餐快，环境一般');
  ok('indexMeta drops rows without a storeKey', (function () {
    indexMeta([null, { note: '没有 key' }, { storeKey: 'K', note: 'x' }]);
    return Object.keys(storeMeta).length === 1;
  })(), Object.keys(storeMeta).join(','));

  indexMeta([{ storeKey: 'B店|哈尔滨', note: '出餐快，环境一般' }]);
  noteDraft = {}; editingNoteKey = null;
  const noteHtml = storeNoteHtml(B);
  ok('storeNoteHtml renders the saved note', noteHtml.indexOf('出餐快，环境一般') !== -1, noteHtml);
  ok('storeNoteHtml offers an edit entry', noteHtml.indexOf('data-noteedit="B店"') !== -1);
  ok('storeNoteHtml labels it as a store-level review', noteHtml.indexOf('店铺整体评价') !== -1);
  ok('storeCard embeds the store note', storeCard(B).indexOf('出餐快，环境一般') !== -1);

  const blankHtml = storeNoteHtml(A);
  ok('storeNoteHtml shows a write entry when there is no note yet',
     blankHtml.indexOf('data-noteedit="A店"') !== -1 && blankHtml.indexOf('写店铺整体评价') !== -1, blankHtml);

  editingNoteKey = 'B店';
  const editHtml = storeNoteHtml(B);
  ok('storeNoteHtml switches to a textarea while editing',
     editHtml.indexOf('data-noteinput="B店"') !== -1 &&
     editHtml.indexOf('data-notesave=') !== -1 && editHtml.indexOf('data-notecancel=') !== -1, editHtml);
  ok('the textarea is pre-filled with the saved note', editHtml.indexOf('出餐快，环境一般') !== -1);
  // 列表会因搜索 / 排序被整块重绘，输入中的草稿必须比已保存的内容优先
  noteDraft['B店'] = '打到一半的内容';
  ok('an in-progress draft wins over the saved note',
     storeNoteHtml(B).indexOf('打到一半的内容') !== -1, storeNoteHtml(B));
  ok('the draft does not leak onto other stores',
     storeNoteHtml(A).indexOf('打到一半的内容') === -1);
  noteDraft = {}; editingNoteKey = null;

  // 展开状态存在 openReviewKeys 里：保存店铺评价会整块重绘列表，
  // 不记着的话用户刚点开的订单评价会被当场收回去
  ok('an expanded store keeps its review list open across re-renders', (function () {
    openReviewKeys.add('B店');
    const opened = storeCard(B);
    const isOpen = opened.indexOf('<div class="reviews open">') !== -1;
    const label = opened.indexOf('收起评价 ▴') !== -1;
    openReviewKeys.delete('B店');
    const collapsed = storeCard(B);
    return isOpen && label &&
      collapsed.indexOf('<div class="reviews">') !== -1 &&
      collapsed.indexOf('查看 20 条订单评价') !== -1;
  })());

  // ---- v2.5：多图不再只渲染前 4 张 ----
  const manyImgs = groupByStore([0, 1, 2, 3, 4, 5, 6].map((i) => ({
    id: 'g' + i, storeKey: 'G店|', storeName: 'G店', city: '',
    platform: '', foodType: '', channel: '', items: '', totalPrice: 10, people: 1,
    rating: 5, review: '', dishImage: IMG + i, date: now - i,
  })))[0];
  const gHtml = storeCard(manyImgs);
  ok('the thumbnail strip renders every image, not just the first four', (function () {
    const cut = gHtml.split('<div class="dish-strip">')[1];
    const seg = cut ? cut.split('</div>')[0] : '';
    return (seg.match(/class="zoomable"/g) || []).length === 7;
  })(), 'strip n=' + (gHtml.split('<div class="dish-strip">')[1] || '').split('</div>')[0]);
  ok('the strip tells the user it scrolls', gHtml.indexOf('共 7 张，左右滑动查看') !== -1);
  ok('four or fewer images do not need the scroll hint', storeCard(B).indexOf('左右滑动查看') === -1);

  // ---- v2.5：图集 lightbox ----
  const galleryImg = {
    closest: () => ({
      querySelectorAll: () => [
        { getAttribute: () => 'A' }, { getAttribute: () => 'B' },
        { getAttribute: () => 'A' }, { getAttribute: () => null },
      ],
    }),
    getAttribute: () => 'A',
  };
  const gal = collectGallery(galleryImg);
  ok('collectGallery dedupes and drops blank srcs', gal.join(',') === 'A,B', gal.join(','));
  ok('collectGallery falls back to the clicked image when there is no store card',
     collectGallery({ closest: () => null, getAttribute: () => 'Z' }).join(',') === 'Z');

  closeLightbox();
  openLightbox('B', ['A', 'B', 'C']);
  ok('openLightbox opens on the clicked image', getEl('#lightbox-img').src === 'B', getEl('#lightbox-img').src);
  ok('openLightbox shows the position counter',
     getEl('#lb-count').textContent === '2 / 3', getEl('#lb-count').textContent);
  ok('openLightbox shows the arrows for a multi-image set',
     getEl('#lb-prev').hidden === false && getEl('#lb-next').hidden === false);
  ok('the lightbox layer is visible while browsing', getEl('#lightbox').hidden === false);
  lbStep(1);
  ok('lbStep moves forward', getEl('#lightbox-img').src === 'C' && getEl('#lb-count').textContent === '3 / 3');
  lbStep(1);
  ok('lbStep wraps around at the end', getEl('#lightbox-img').src === 'A' && getEl('#lb-count').textContent === '1 / 3');
  lbStep(-1);
  ok('lbStep wraps backwards too', getEl('#lightbox-img').src === 'C', getEl('#lightbox-img').src);
  closeLightbox();
  ok('closeLightbox drops the image, the list and the layer',
     getEl('#lightbox').hidden === true && getEl('#lightbox-img').src === '' && lbList.length === 0);

  // 只有一张图时箭头和计数都是噪音
  openLightbox('A', ['A']);
  ok('a single image hides the arrows and the counter',
     getEl('#lb-prev').hidden === true && getEl('#lb-next').hidden === true &&
     getEl('#lb-count').textContent === '');
  lbStep(1);
  ok('lbStep is a no-op for a single image', getEl('#lightbox-img').src === 'A');
  closeLightbox();
  openLightbox('', ['A']);
  ok('openLightbox ignores an empty src', getEl('#lightbox').hidden === true);

  // ---- v2.5：备份格式（老格式必须还能读） ----
  const legacy = parseBackup(JSON.stringify([{ storeName: 'X', id: '1', rating: 5 }]));
  ok('parseBackup reads the old array-only format',
     !legacy.error && legacy.rows.length === 1 && legacy.metas.length === 0);
  const v2 = parseBackup(JSON.stringify({
    app: 'waimai-pingjia', version: 2,
    orders: [{ storeName: 'X', id: '1', rating: 5 }],
    storeMeta: [{ storeKey: 'X|', note: '备注' }],
  }));
  ok('parseBackup reads the v2 envelope',
     !v2.error && v2.rows.length === 1 && v2.metas.length === 1 && v2.metas[0].note === '备注');
  ok('parseBackup tolerates a missing storeMeta',
     parseBackup(JSON.stringify({ orders: [] })).metas.length === 0);
  ok('parseBackup tolerates a non-array storeMeta',
     parseBackup(JSON.stringify({ orders: [], storeMeta: 'nope' })).metas.length === 0);
  ok('parseBackup strips a UTF-8 BOM',
     parseBackup(String.fromCharCode(0xFEFF) + JSON.stringify([{ a: 1 }])).rows.length === 1);
  ok('parseBackup rejects broken JSON', !!parseBackup('{不是 json').error, JSON.stringify(parseBackup('{不是 json')));
  ok('parseBackup rejects a random object', !!parseBackup('{"hello":1}').error);
  ok('parseBackup rejects a bare number', !!parseBackup('42').error);
  ok('parseBackup does not throw on null', !!parseBackup(null).error);

  // ---- v2.8：待点评（想吃清单） ----
  const wl = [
    { id: 'w1', storeName: '肉夹馍', city: '哈尔滨', category: '餐饮', foodType: '小吃',
      want: '凉皮', reason: '室友推荐', priority: 3, createdAt: now - 3 * DAY },
    { id: 'w2', storeName: '盒马', city: '哈尔滨', category: '生鲜', foodType: '水果',
      want: '草莓', reason: '', priority: 2, createdAt: now - DAY },
    { id: 'w3', storeName: '三只松鼠', city: '', category: '零食', foodType: '坚果炒货',
      want: '', reason: '骑车路过看到的', priority: 1, createdAt: now - 40 * DAY },
  ];
  wishes = wl;
  wishSort = 'priority';
  wishQ = '';
  ok('visibleWishes sorts by priority first',
     visibleWishes().map((w) => w.id).join(',') === 'w1,w2,w3',
     visibleWishes().map((w) => w.id).join(','));
  wishSort = 'created';
  ok('visibleWishes sorts by createdAt when asked',
     visibleWishes().map((w) => w.id).join(',') === 'w2,w1,w3',
     visibleWishes().map((w) => w.id).join(','));
  ok('visibleWishes does not reorder the cache in place', wishes[0].id === 'w1', wishes[0].id);
  wishSort = 'priority';
  wishQ = '草莓';
  ok('visibleWishes searches what you want to eat',
     visibleWishes().length === 1 && visibleWishes()[0].id === 'w2');
  wishQ = '路过';
  ok('visibleWishes searches the reason too',
     visibleWishes().length === 1 && visibleWishes()[0].id === 'w3');
  wishQ = '哈尔滨';
  ok('visibleWishes searches the city', visibleWishes().length === 2, String(visibleWishes().length));
  wishQ = '凑不出来的词';
  ok('visibleWishes returns nothing for a miss', visibleWishes().length === 0);
  wishQ = '';

  renderWishes();
  ok('renderWishes writes both header counts',
     getEl('#w-count').textContent === '3 家在等着去' &&
     getEl('#w-extra').textContent === '共 3 家 · 1 家超想吃',
     getEl('#w-count').textContent + ' / ' + getEl('#w-extra').textContent);
  ok('renderWishes renders one card per wish',
     (getEl('#wish-list').innerHTML.match(/class="wish"/g) || []).length === 3);
  ok('renderWishes keeps the sorter while there is data', getEl('#w-sort').hidden === false);
  wishes = [];
  renderWishes();
  ok('renderWishes hides the sorter and the search box when empty',
     getEl('#w-sort').hidden === true && getEl('#wq').hidden === true);
  ok('renderWishes shows the empty state for a clean list',
     getEl('#wish-list').innerHTML.indexOf('还没有想吃的') !== -1);
  wishes = wl;

  ok('wishCard renders the priority pill', wishCard(wl[0]).indexOf('pri p3') !== -1);
  ok('wishCard omits the reason block when there is none',
     wishCard(wl[1]).indexOf('wish-reason') === -1);
  ok('wishCard skips empty fields without dangling separators',
     wishCard(wl[2]).indexOf('·  ·') === -1 &&
     wishCard(wl[2]).indexOf('<div class="wish-sub">零食 · 坚果炒货</div>') !== -1,
     wishCard(wl[2]));
  ok('wishCard escapes html in user text',
     wishCard({ id: 'x', storeName: '<b>坏</b>', priority: 2, createdAt: now }).indexOf('&lt;b&gt;') !== -1);
  ok('wishCard falls back to a valid pill for an unknown priority',
     wishCard({ id: 'x', storeName: 'X', priority: 9, createdAt: now }).indexOf('pri p2') !== -1);

  ok('relDay speaks in relative days',
     relDay(now) === '今天' && relDay(now - DAY) === '昨天' &&
     relDay(now - 3 * DAY) === '3 天前' && relDay(now - 40 * DAY) === '1 个月前',
     relDay(now - 40 * DAY));

  // 待点评的值要并进录单候选池，且按大类分桶
  refreshHistory(orders, [{ id: 'w1', storeName: 'Z店', city: '齐齐哈尔',
                            category: '生鲜', foodType: '水产' }]);
  setFormCategory('生鲜', false);
  ok('refreshHistory merges wish values into the buckets',
     histValues.city.indexOf('齐齐哈尔') !== -1 && histValues.foodType.indexOf('水产') !== -1,
     histValues.city.join(','));
  setFormCategory('餐饮', false);
  ok('wish values stay inside their own category bucket',
     histValues.city.indexOf('齐齐哈尔') === -1, histValues.city.join(','));
  refreshHistory(orders);
  setFormCategory('生鲜', false);
  ok('the wish list is optional for refreshHistory (no leak when omitted)',
     histValues.city.indexOf('齐齐哈尔') === -1, histValues.city.join(','));
  setFormCategory('餐饮', false);

  // 备份格式 v3：老备份 / 新备份 / 垃圾字段三种都得认
  ok('parseBackup carries wishes from a v3 envelope',
     parseBackup(JSON.stringify({ orders: [], wishes: [{ id: 'w1' }] })).wishes.length === 1);
  ok('parseBackup treats a non-array wishes as an empty list',
     parseBackup(JSON.stringify({ orders: [], wishes: 'nope' })).wishes.length === 0);
  ok('parseBackup gives the old array format an empty wishes list',
     parseBackup(JSON.stringify([{ storeName: 'X' }])).wishes.length === 0);
  ok('parseBackup always returns all three keys',
     ['rows', 'metas', 'wishes'].every((k) => k in parseBackup(JSON.stringify({ orders: [] }))));

  // ---- 同款订单：自动归组 ----
  // 判定键 = 9 项业务字段，**刻意放过 rating / review**（它们正是组头要合并展示的
  // 两项），也放过 **totalPrice 和 date** —— 每次的钱各算各的、日期要跨天，
  // 这两项一旦进判定，「看这款点了几次、每次什么时候、每次多少钱」就无从谈起。
  // 其余 9 项全参与：同一家店点两样不同的东西、一次 1 人一次 3 人，是真的两款。
  const dupOrder = (id, rating, review, extra) => Object.assign({
    id, storeName: '老潼关肉夹馍', city: '哈尔滨', platform: '饿了么',
    category: '餐饮', foodType: '快餐', channel: '仅外卖',
    items: '肉夹馍', totalPrice: 25, people: 2, unit: 'fen',
    rating, review, dishImage: null, date: new Date(2026, 9, 11, 12, 0).getTime(),
  }, extra || {});
  const SEP = String.fromCharCode(1);

  const dA = dupOrder('d1', 5, '肉夹馍很香');
  const dF = dupOrder('d6', 3, '换了个说法');               // 只差评分和评语 → 同款
  const dB = dupOrder('d2', 4, '汤也好喝',
    { date: new Date(2026, 9, 12, 19, 30).getTime() });      // 只差日期 → 同款
  const dD = dupOrder('d4', 3, '还行', { totalPrice: 30 });  // 只差金额 → 同款
  const dC = dupOrder('d3', 4, '一般', { items: '凉皮' });    // 点的东西不同
  const dE = dupOrder('d5', 4, 'x', { people: 4 });          // 人数不同

  ok('dupKeyOf ignores rating and review (that is the whole point)',
     dupKeyOf(dA) === dupKeyOf(dF), dupKeyOf(dA).split(SEP).join(' / '));
  ok('dupKeyOf ignores the date, so a favourite dish spans days',
     dupKeyOf(dA) === dupKeyOf(dB));
  ok('dupKeyOf ignores the amount: each visit keeps its own money',
     dupKeyOf(dA) === dupKeyOf(dD));
  ok('dupKeyOf separates records that ordered different things',
     dupKeyOf(dA) !== dupKeyOf(dC));
  ok('dupKeyOf separates records with a different headcount',
     dupKeyOf(dA) !== dupKeyOf(dE));
  ok('dupKeyOf compares the headcount by value, not by type',
     dupKeyOf(dupOrder('d7', 5, '', { people: '2' })) === dupKeyOf(dA));
  ok('dupKeyOf still pairs records that have no store name',
     dupKeyOf(dupOrder('i1', 5, 'x', { storeName: '' })) ===
     dupKeyOf(dupOrder('i2', 5, 'y', { storeName: '' })));

  // 组头摘要：笔数 / 合计 / 均价 / 日期跨度 / 合并评语 / 平均分。
  // 全是**渲染时现算**的，一条订单都没动过 —— 所以不需要撤销，也没有残留。
  const head = dupGroupHead([dA, dB]);
  ok('dupGroupHead counts how many times this dish was ordered',
     head.count === 2, head.count);
  ok('dupGroupHead adds up what each visit cost', head.sum === 50, head.sum);
  ok('dupGroupHead averages that over the visits', head.avg === 25, head.avg);
  ok('dupGroupHead spans from the first visit to the latest',
     head.first === dA.date && head.last === dB.date);
  ok('dupGroupHead joins the reviews with a semicolon',
     head.review === '肉夹馍很香；汤也好喝', head.review);
  ok('dupGroupHead averages the ratings to one decimal', head.rating === 4.5, head.rating);
  ok('dupGroupHead drops duplicate and empty reviews',
     dupGroupHead([dupOrder('e1', 4, '还行'), dupOrder('e2', 4, '还行'),
                   dupOrder('e3', 4, '')]).review === '还行');
  ok('dupGroupHead rounds a three-way average to one decimal',
     dupGroupHead([dupOrder('f1', 4, 'a'), dupOrder('f2', 4, 'b'),
                   dupOrder('f3', 5, 'c')]).rating === 4.3);
  ok('dupGroupHead ignores a zero rating instead of dragging the average down',
     dupGroupHead([dupOrder('h1', 5, 'x'), dupOrder('h2', 0, 'y')]).rating === 5);
  ok('dupGroupHead reports an all-zero group as 0, not NaN',
     dupGroupHead([dupOrder('h3', 0, 'x')]).rating === 0);
  ok('dupGroupHead copes with a group that has no usable date at all',
     dupGroupHead([dupOrder('h4', 5, 'x', { date: 0 })]).first === 0);

  // 列表渲染：同款自动折成一块，组内每条照旧，一条数据都没少
  const foldHtml = reviewListHtml([dA, dC, dB], (o) => esc(o.id));
  ok('reviewListHtml folds the same dish into exactly one block',
     foldHtml.split('class="dup-block"').length - 1 === 1);
  ok('reviewListHtml keeps every original record inside the block',
     foldHtml.split('class="review-item"').length - 1 === 3);
  ok('reviewListHtml shows how many times this dish was ordered',
     foldHtml.indexOf('同款 2 笔') !== -1);
  ok('reviewListHtml shows the total and the average per visit',
     foldHtml.indexOf('共 ¥50') !== -1 && foldHtml.indexOf('均价 ¥25.0') !== -1);
  ok('reviewListHtml shows the day span of the group',
     foldHtml.indexOf('10/11 ~ 10/12') !== -1);
  ok('reviewListHtml merges the reviews into the head',
     foldHtml.indexOf('肉夹馍很香；汤也好喝') !== -1);
  ok('reviewListHtml no longer offers a 拆开 button (nothing to undo)',
     foldHtml.indexOf('data-unfold') === -1);
  ok('reviewListHtml leaves a one-off dish flat',
     reviewListHtml([dA, dC], (o) => esc(o.id)).indexOf('dup-block') === -1);
  // 筛选后组里只剩一条：不套组头（摆个「同款 1 笔」只会让人以为数据坏了）
  ok('a member left alone by the filter is not wrapped in a header',
     reviewListHtml([dB], (o) => esc(o.id)).indexOf('dup-block') === -1);

  // 合并会产出 4.5 这种小数，读分数的那格不能再用 parseInt
  getEl('#rating').value = '4.5';
  ok('readRating keeps one decimal', readRating() === 4.5, readRating());
  getEl('#rating').value = '';
  ok('readRating falls back to 5 on an empty slider', readRating() === 5, readRating());
  getEl('#rating').value = '9';
  ok('readRating clamps into the 1..5 range', readRating() === 5, readRating());
  getEl('#rating').value = '';

  // 编辑一条只有 date、没有 orderDate 的老单，日期该回填它自己那天
  writeForm({ storeName: 'X', date: new Date(2026, 7, 1, 9, 30).getTime() });
  ok('writeForm falls back to the order date, not to today',
     getEl('#orderDate').value === '2026-08-01', getEl('#orderDate').value);

  // ---- v3.3.0：候选项上的单数（分面计数） ----
  // 「这一项选下去有几单」= 把它当成选中值**重跑一遍完整过滤**。关键在跳掉自己
  // 那一维：已经筛了「生鲜」的时候，「餐饮」上还得写着 4 —— 那正是用户想点回去的。
  const mkCat = (id, name, cat, food, price) => ({
    id, storeKey: name + '|哈尔滨', storeName: name, city: '哈尔滨',
    platform: '美团', category: cat, foodType: food, channel: '仅外卖', items: '',
    totalPrice: price, people: 1, rating: 5, review: '', dishImage: null,
    date: new Date(2026, 8, 10).getTime(),
  });
  const facetOrders = [
    mkCat('p1', 'P店', '餐饮', '快餐', 30),
    mkCat('p2', 'P店', '餐饮', '快餐', 20),
    mkCat('p3', 'P店', '餐饮', '日料', 40),
    mkCat('p4', 'Q店', '餐饮', '快餐', 25),
    mkCat('p5', '', '生鲜', '苹果', 15),
    mkCat('p6', '', '生鲜', '香蕉', 12),
    mkCat('p7', '', '零食', '薯片', 8),
  ];
  ['#f-month', '#f-store', '#f-city', '#f-platform', '#f-cat', '#f-food', '#f-channel',
   '#f-min', '#f-max'].forEach((s) => { getEl(s).value = ''; });
  getEl('#q').value = '';

  ok('facetCountFor 数的是该取值下的单数', facetCountFor(facetOrders, 'cat', '餐饮') === 4,
     'got=' + facetCountFor(facetOrders, 'cat', '餐饮'));
  ok('facetCountFor 不限 = 全部单数', facetCountFor(facetOrders, 'cat', '') === 7,
     'got=' + facetCountFor(facetOrders, 'cat', ''));
  ok('facetCountFor 也认店铺维度', facetCountFor(facetOrders, 'store', 'P店') === 3,
     'got=' + facetCountFor(facetOrders, 'store', 'P店'));
  ok('facetCountFor 也认小类维度', facetCountFor(facetOrders, 'food', '快餐') === 3,
     'got=' + facetCountFor(facetOrders, 'food', '快餐'));

  // 计数必须**跳掉自己那一维**：筛了「生鲜」之后，「餐饮」上还得写着 4。
  getEl('#f-cat').value = '生鲜';
  ok('候选单数不受自己那一维的筛选影响', facetCountFor(facetOrders, 'cat', '餐饮') === 4,
     'got=' + facetCountFor(facetOrders, 'cat', '餐饮'));
  // 注意：生鲜按**小类**分组，所以「苹果」和「香蕉」是两组、各 1 单 ——
  // 不是一组两单。这正是「餐饮按店铺、生鲜零食按小类」那条分组约定的体现。
  ok('但自己那一维仍然照常过滤（列表本身没变松）',
     filterStores(facetOrders).length === 2 &&
     filterStores(facetOrders).every((g) => g.kind === 'food' && g.count === 1),
     'n=' + filterStores(facetOrders).length);
  ok('别的维度的单数会跟着大类筛选一起缩',
     facetCountFor(facetOrders, 'food', '苹果') === 1 &&
     facetCountFor(facetOrders, 'food', '快餐') === 0,
     '苹果=' + facetCountFor(facetOrders, 'food', '苹果') +
     ' 快餐=' + facetCountFor(facetOrders, 'food', '快餐'));
  getEl('#f-cat').value = '';

  // 关键词也要算进去 —— 搜索框里打着字的时候，候选数字不能还是全量
  getEl('#q').value = 'P店';
  ok('关键词参与了候选计数', facetCountFor(facetOrders, 'food', '快餐') === 2,
     'got=' + facetCountFor(facetOrders, 'food', '快餐'));
  getEl('#q').value = '';

  // 均价区间是**组级**判据，不能只走逐单判：min=28 时 P店(均价30)留下、Q店(25)出局
  getEl('#f-min').value = '28';
  ok('均价区间参与了候选计数', facetCountFor(facetOrders, 'cat', '餐饮') === 3,
     'got=' + facetCountFor(facetOrders, 'cat', '餐饮'));
  getEl('#f-min').value = '';

  // 渲染：大类快捷条的数字
  renderFacetCounts(facetOrders);
  ok('快捷条「全部」写的是总单数', segBtns[0].__num.textContent === '7',
     segBtns[0].__num.textContent);
  ok('快捷条三个大类各自有数',
     segBtns[1].__num.textContent === '4' && segBtns[2].__num.textContent === '2' &&
     segBtns[3].__num.textContent === '1',
     [segBtns[1], segBtns[2], segBtns[3]].map((b) => b.__num.textContent).join('/'));

  // 渲染：三个下拉的候选
  fillFilterOptions(facetOrders);
  renderFacetCounts(facetOrders);
  const optOf = (sel, v) => getEl(sel).options.filter((o) => o.value === v)[0];
  ok('店铺候选带上自己的单数',
     optOf('#f-store', 'P店') && optOf('#f-store', 'P店').textContent === 'P店（3）',
     optOf('#f-store', 'P店') && optOf('#f-store', 'P店').textContent);
  ok('小类候选带上自己的单数',
     optOf('#f-food', '快餐') && optOf('#f-food', '快餐').textContent === '快餐（3）',
     optOf('#f-food', '快餐') && optOf('#f-food', '快餐').textContent);
  ok('大类候选带上自己的单数',
     optOf('#f-cat', '餐饮') && optOf('#f-cat', '餐饮').textContent === '餐饮（4）',
     optOf('#f-cat', '餐饮') && optOf('#f-cat', '餐饮').textContent);
  ok('「全部」那一项不挂数字（它是「不限」，挂个总数会被读成「一共 N 单」）',
     getEl('#f-store').options[0].textContent === '全部' &&
     getEl('#f-cat').options[0].textContent === '全部');
  // 重写的是**文字**，value 必须原样 —— 动了它，当前选中的那一项会当场失效
  getEl('#f-store').value = 'P店';
  renderFacetCounts(facetOrders);
  ok('重写候选文字不会动 option.value',
     getEl('#f-store').value === 'P店' && !!optOf('#f-store', 'P店'),
     getEl('#f-store').value);
  // 重算是覆盖写而不是追加：连跑两遍不该长出「P店（3）（3）」
  ok('候选文字是覆盖写，不累积', optOf('#f-store', 'P店').textContent === 'P店（3）',
     optOf('#f-store', 'P店').textContent);
  getEl('#f-store').value = '';
  // 一条数据都没有时数字要归零，别留着上一次的
  renderFacetCounts([]);
  ok('没有订单时候选数字归零',
     segBtns[0].__num.textContent === '0' && optOf('#f-store', 'P店').textContent === 'P店（0）',
     segBtns[0].__num.textContent + ' / ' + optOf('#f-store', 'P店').textContent);

  globalThis.__RESULT__ = out.join('\\n');
})();
`;

sandbox.__RESULT__ = '';
vm.createContext(sandbox);
try {
  vm.runInContext(src + TEST, sandbox, { filename: 'app.js' });
} catch (e) {
  console.log('SMOKE TEST CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

const lines = String(sandbox.__RESULT__).split('\n');
const fails = lines.filter((l) => l.startsWith('FAIL'));
console.log(lines.join('\n'));
console.log('');
console.log('total=' + lines.length + '  pass=' + (lines.length - fails.length) + '  fail=' + fails.length);
process.exit(fails.length ? 1 : 0);

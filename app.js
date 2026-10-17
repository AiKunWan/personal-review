// 个人点评 PWA — 纯前端 + IndexedDB 本地存储
const DB_NAME = 'waimai_pingjia';
/**
 * v2 新增 storeMeta（店铺整体评价），v3 新增 wishes（待点评 / 想吃清单）。
 * 每次升级只**新建**一张表、不碰 orders，所以手机上已有的订单原样保留 ——
 * onupgradeneeded 会带着 oldVersion 触发，下面按「缺哪个建哪个」处理，
 * 重复运行也安全。也正因为如此，这里从头到尾没有任何数据迁移代码。
 *
 * v3.0（个人点评）**没有动表结构**：店铺的「支持的消费方式」是挂在
 * storeMeta 那一行上的一个 channels 数组（和 note 同一个 keyPath=storeKey），
 * 老行没有这个字段 → 读的时候给 []，所以 DB_VERSION 仍然停在 3。
 *
 * v3.0.1 也沿用这个思路：**小类评价也塞进 storeMeta**，键是 'food:' + 小类名
 * （和列表页的分组键同一个值）。同样的理由 —— 它是「一个小类一条、与具体订单无关」
 * 的记录，和新开一张表要做的事一模一样，而新表就必须升 DB_VERSION，
 * 升了之后**旧版 APK 会打不开这个库**（老包请求版本 3 < 实际 4）。
 * 键不会撞：店铺身份 storeKeyOf() 一定含 '|'，'food:小类名' 一定不含。
 */
const DB_VERSION = 3;
const STORE = 'orders';
const STORE_META = 'storeMeta';
const STORE_WISH = 'wishes';

// ---------- 数据库 ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('storeKey', 'storeKey', { unique: false });
      }
      // 店铺整体评价挂 keyPath=storeKey，一家店一条，天然幂等
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'storeKey' });
      }
      // 待点评（想吃清单）挂 keyPath=id，和 orders 一样自带唯一键。
      // 不建索引：清单量级是几十条，全量读出来在内存里排序比走索引简单得多
      if (!db.objectStoreNames.contains(STORE_WISH)) {
        db.createObjectStore(STORE_WISH, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // 旧连接占着不放时 open 会**永远不回调**，init 卡在这里，
    // 整个应用页面渲染正常但所有事件都没绑上 —— 点哪都没反应且无任何提示
    req.onblocked = () => reject(new Error('数据库被其他窗口占用，请关掉其他标签页后重开'));
  });
}

let db;
async function getAll() {
  return new Promise((resolve, reject) => {
    let tx;
    // db 还没打开（openDB 失败 / 被占用）时 transaction 会直接抛 —— 接住并 reject。
    // 漏了这层，这个 Promise 永远悬着、init 卡在 await 上：页面看着正常但什么都点不动。
    try { tx = db.transaction(STORE, 'readonly'); } catch (e) { reject(e); return; }
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => { if (!settled) { settled = true; resolve(req.result || []); } };
    req.onerror = () => fail(req.error);
    // 只读事务同样可能 abort（配额 / 提交阶段失败）—— 不接住就永远不 settle
    tx.onabort = () => fail(tx.error || new Error('读取被中止'));
  });
}

/**
 * 写事务封装（可指定一个或多个仓库）。**必须同时接 `onabort`。**
 * 配额超限、提交阶段失败时触发的是 abort 事件，`onerror` 不一定来；
 * 少了它 Promise 永不 settle —— 表现就是「按钮点了毫无反应」或永久卡在「删除中…」，
 * 而且不抛错、不提示。这是 IndexedDB 上最容易漏掉的一处静默死路。
 * 顺带把 `put` 的同步异常（如缺 keyPath 触发的 DataError）也收进 reject。
 *
 * 回调拿到的是 **tx 而不是 objectStore**：整店删除要同时动 orders 和 storeMeta，
 * 两个仓库合在一个事务里才可能真正原子。分成两个事务的话，
 * 订单删掉了、备注没删掉，就留下一条谁也看不见、也删不掉的孤儿备注。
 */
function txWriteIn(storeNames, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, 'readwrite');
    } catch (e) {
      reject(e);
      return;
    }
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(); } };
    tx.onerror = () => fail(tx.error || new Error('写入失败'));
    tx.onabort = () => fail(tx.error || new Error('写入被中止（多为本地存储空间不足）'));
    try {
      fn(tx);
    } catch (e) {
      fail(e);
    }
  });
}
function txWrite(fn) { return txWriteIn(STORE, (tx) => fn(tx.objectStore(STORE))); }
function txWriteMeta(fn) { return txWriteIn(STORE_META, (tx) => fn(tx.objectStore(STORE_META))); }
function txWriteBoth(fn) { return txWriteIn([STORE, STORE_META], fn); }

async function putOrder(o) { return txWrite((s) => s.put(o)); }
async function deleteOrder(id) { return txWrite((s) => s.delete(id)); }
// 一组订单一起删（小类卡片的「删除整组」）。合成一个事务，理由和整店删除一样：
// 逐条删要开 N 个事务，慢，而且中途失败会在库里留下删了一半的一组
// —— 用户看到的那组数字和实际剩下的对不上。
async function deleteOrders(ids) {
  if (!ids || !ids.length) return;
  return txWrite((s) => { ids.forEach((id) => s.delete(id)); });
}
// 整店删除：逐条 deleteOrder 会开 N 个事务，慢且失败面大，合并成一个事务。
// 店铺整体评价跟着一起删 —— 店都没了，留着那段备注只是垃圾。
async function deleteStoreAll(key, ids) {
  return txWriteBoth((tx) => {
    const os = tx.objectStore(STORE);
    ids.forEach((id) => os.delete(id));
    tx.objectStore(STORE_META).delete(key);
  });
}
async function clearAll() {
  // 待点评也一起清。只清订单会让清单变成孤儿：那些「想吃的店」还在，
  // 但上下文（吃过什么、在哪吃）全没了，用户还以为出现了幽灵数据
  return txWriteIn([STORE, STORE_META, STORE_WISH], (tx) => {
    tx.objectStore(STORE).clear();
    tx.objectStore(STORE_META).clear();
    tx.objectStore(STORE_WISH).clear();
  });
}

// ---------- 店铺整体评价 ----------
// 单独一张表，不塞进 orders：店铺评价不属于任何一次订单，
// 挂在订单上就得挑一条当宿主，删了那条订单评价也跟着没了。
// （v3.0 起这张表还顺带存「支持的消费方式」—— 同样是「一家店一条」的东西，
//   见下面那一节的注释，别为它另开一张表。）
/**
 * 读全部店铺评价。表不存在时**返回空数组而不是抛错**：
 * 备注是附加功能，它出问题绝不能把整个店铺列表一起拖垮 ——
 * 宁可少显示一段备注，也不能让主数据看不见。
 */
async function getAllMeta() {
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE_META, 'readonly');
    } catch (e) {
      resolve([]);
      return;
    }
    const req = tx.objectStore(STORE_META).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
    // 只读事务也会 abort。备注是附加功能，一律兜成空数组，不能把主流程拖垮
    tx.onabort = () => resolve([]);
  });
}
async function putMeta(m) { return txWriteMeta((s) => s.put(m)); }
async function deleteMeta(keys) { return txWriteMeta((s) => { keys.forEach((k) => s.delete(k)); }); }

// ---------- 待点评（想吃清单） ----------
/**
 * 记「想尝但还没吃过」的店 / 商品。**刻意和 orders 分表**：
 * 它没有价格、人数、评分、平台、日期 —— 还没吃，这些值根本不存在。
 * 硬塞进 orders 就得给一堆必填字段编假值，之后统计页还得满世界过滤它们。
 *
 * 表不存在时返回空数组而不是抛错，理由同 getAllMeta：
 * 待点评是附加功能，它出问题绝不能把整个应用拖垮。
 */
async function getAllWishes() {
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE_WISH, 'readonly');
    } catch (e) {
      resolve([]);
      return;
    }
    const req = tx.objectStore(STORE_WISH).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
    tx.onabort = () => resolve([]);   // 同上：待点评是附加功能，静默兜底
  });
}
function txWriteWish(fn) { return txWriteIn(STORE_WISH, (tx) => fn(tx.objectStore(STORE_WISH))); }
async function putWish(w) { return txWriteWish((s) => s.put(w)); }
async function deleteWish(id) { return txWriteWish((s) => s.delete(id)); }

// 内存缓存。数量级是几十条，全量读出来放内存里排 / 搜比走索引省事
let wishes = [];

// storeKey -> { storeKey, note, channels, updatedAt }
// **小类评价也存在这张表里**，键形如 'food:苹果' —— 见下面的 FOOD_GROUP_PREFIX。
let storeMeta = {};

/**
 * 归一后需要从库里删掉的旧键。indexMeta 发现 `店名|地点` 那种老键时记在这里，
 * 由调用方（refreshAll）调 migrateMetaKeys 一次性写回 + 清旧行。
 */
let staleMetaKeys = [];

/**
 * 一行 storeMeta 属于哪一类：'store'（店铺）/ 'food'（小类）。
 *
 * **优先看行上的 `kind` 字段**（v3.0.2 起写入时一定带），只在老行没有它时
 * 才退回「看键前缀」。这一步是必需的：店铺身份自 v3.0.2 起是**纯店名**，
 * 「店铺键一定含 `|`」这条键隔离前提没有了 —— 一家叫「food:包子」的店
 * 会被纯前缀判断误当小类行，从此不出现在店铺列表里、删店也删不掉。
 */
function kindOfRow(key, row) {
  if (row && (row.kind === 'food' || row.kind === 'store')) return row.kind;
  return isFoodMetaKey(key) ? 'food' : 'store';
}

/** 合并同一归属的两行：note 取 updatedAt 新的，channels 取并集（不丢任何一项）。 */
function mergeMetaRow(a, b) {
  const newer = (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a;
  const older = newer === b ? a : b;
  const out = Object.assign({}, older, newer);
  const ch = [];
  for (const v of [].concat(a.channels || [], b.channels || [])) {
    const t = String(v == null ? '' : v).trim();
    if (t && ch.indexOf(t) === -1) ch.push(t);
  }
  if (ch.length) out.channels = ch; else delete out.channels;
  out.note = newer.note || older.note || '';
  out.storeKey = newer.storeKey;
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  out.kind = kindOfRow(newer.storeKey, newer);
  return out;
}

/**
 * 把存储层读回来的行搬进内存缓存，顺手做两件归一（v3.0.2）：
 *   ① 键：老的 `店名|地点` 合并到 `店名`（note 取新的，channels 取并集）
 *   ② kind：老行没有这个字段，按前缀补一个
 * 返回 true 表示这一轮改动了键，调用方要调 migrateMetaKeys 写回。
 */
function indexMeta(rows) {
  storeMeta = {};
  staleMetaKeys = [];
  for (const m of rows || []) {
    if (!m || !m.storeKey) continue;
    const raw = String(m.storeKey);
    // 小类行的键不含 `|`，normStoreKey 原样返回；店铺行老格式会被切掉地点
    const key = isFoodMetaKey(raw) ? raw : normStoreKey(raw);
    const row = Object.assign({}, m, { storeKey: key });
    if (row.kind !== 'food' && row.kind !== 'store') row.kind = isFoodMetaKey(raw) ? 'food' : 'store';
    if (key !== raw) staleMetaKeys.push(raw);
    const prev = storeMeta[key];
    storeMeta[key] = prev ? mergeMetaRow(prev, row) : row;
  }
  return staleMetaKeys.length > 0;
}

/** 把归一后的行写回、删掉旧键。**失败不影响本次使用** —— 内存里已经是归一后的。 */
async function migrateMetaKeys() {
  if (!staleMetaKeys.length) return;
  const rows = Object.keys(storeMeta).map((k) => storeMeta[k]);
  const stale = staleMetaKeys.slice();
  staleMetaKeys = [];
  try {
    await txWriteMeta((s) => {
      rows.forEach((r) => s.put(r));
      stale.forEach((k) => s.delete(k));
    });
  } catch (e) { /* 下次启动再试，不弹提示：这属于后台自愈，用户无需知道 */ }
}

/**
 * 「小类」在 storeMeta 里的键前缀。
 *
 * **它和列表页的分组键是同一个值** —— groupOf() 给非餐饮小类产出的 key 就是
 * `'food:' + 小类名`，所以卡片拿着 g.key 就能直接读写小类评价，不需要任何映射。
 *
 * 也正因为这张表里混着两种归属（店铺 / 小类），**任何遍历它的地方都要先想清楚
 * 要不要排除 food: 开头的**（导出的计数提示就踩过这个）。别裸写
 * Object.keys(storeMeta)，走 storeMetaRows。
 *
 * v3.0.2 起「靠前缀区分两归属」**不再是安全前提** —— 店铺身份变成纯店名了，
 * 一家叫「food:包子」的店会被纯前缀判断误当成小类行。所以判归属改走
 * **kindOfRow**（写行时带上 `kind`，只有老行才退回首前缀）。
 * `isFoodMetaKey` 现在只用来认「这个键是小类键」，别再拿它判归属。
 */
const FOOD_GROUP_PREFIX = 'food:';

function isFoodMetaKey(key) { return String(key == null ? '' : key).indexOf(FOOD_GROUP_PREFIX) === 0; }

/**
 * 取某一类归属的 storeMeta 行。kind: 'store'（店铺，默认）/ 'food'（小类）。
 * 判据走 kindOfRow（优先看行上的 kind），理由见上面那段。
 */
function storeMetaRows(kind) {
  const wantFood = kind === 'food';
  return Object.keys(storeMeta)
    .filter((k) => (kindOfRow(k, storeMeta[k]) === 'food') === wantFood)
    .map((k) => storeMeta[k]);
}

/**
 * 按 key **合并写**一条评价：storeMeta 那一行上可能还挂着别的字段。
 *
 * 这是保存评价的**唯一出口** —— 之前写死过一次「{storeKey, note, updatedAt}
 * 整行覆盖」，结果一保存评价就把店铺的「支持的消费方式」抹了。凡是往
 * storeMeta 加字段，都要复查这里没被绕过（小类评价走同一条路，只是不挂 channels）。
 *
 * 只有当这条记录**彻底空了**（没评价、也没店铺清单）时才真删 —— 留一条空字符串
 * 在那儿占位，会让「有没有写过评价」的判断全部失真。
 */
async function writeNoteRow(key, text, kind) {
  const prev = storeMeta[key] || {};
  const channels = Array.isArray(prev.channels) ? prev.channels : [];
  // 归属**尽量显式传进来**（'store' / 'food'），没传才按行推断 ——
  // v3.0.2 起光看键前缀已经不能可靠区分了（见 kindOfRow）。
  const k = (kind === 'food' || kind === 'store') ? kind : kindOfRow(key, prev);
  if (text || channels.length) {
    const row = Object.assign({}, prev, { storeKey: key, kind: k, note: text, updatedAt: Date.now() });
    await putMeta(row);
    storeMeta[key] = row;
  } else {
    await deleteMeta([key]);
    delete storeMeta[key];
  }
}

// ---------- 支持的消费方式（店铺级属性） ----------
// v3.0 引入，v3.0.2 把**方向**反了过来：它不再像一道闸门卡在「实际消费方式」前面
// （那版得先配清单，后面那格才有值可选），而是**从实际消费方式沉淀出来的产物** ——
// 用户在「实际消费方式」里填了什么就自动进这家店的清单，在这里也可以手动增删。
// 它依然值得单独存在：记着「这家店能怎么吃」，下次录同一家店时一点就填。
//
// 为什么挂在 storeMeta 而不是新开一张表：它和「店铺整体评价」是同一件事的两个面
// （都是「一家店一条、与具体订单无关」），共用 storeKey 就不用再维护第二套身份规则，
// 删店 / 导入导出 / 清空也都自动跟着走。代价是老行没有 channels 字段 ——
// 读的时候给 []，和 unit / category 一样靠兜底而不是迁移代码。
//
// `supChannels` 是**表单当前那份**（和 storeMeta 分开：用户正在打字时还没落库）；
// `supForKey` 记着它是哪家店的，避免边打字边被历史值覆盖回去。
let supChannels = [];
let supForKey = '';

/** 表单里当前填的店名（trim 后）。判「有没有店名」全走这一个，别各写各的。 */
function storeNameOf() {
  const el = $('#storeName');
  return String((el && el.value) || '').trim();
}

/**
 * 店铺身份：**只看店名**（v3.0.2 起）。
 *
 * 地点曾经是身份的一部分（`店名|地点`），结果是同一家店填了地点、没填地点
 * 会**裂成两张卡片** —— 而地点只是「这次在哪买」，不是这家店的定义。
 * 老数据里的 `店名|地点` 在读取时统一归一到店名（见 normStoreKey），
 * 所以旧卡片不会散掉，只是合并成一张。
 */
function storeKeyOf(name) {
  return String(name == null ? '' : name).trim();
}

/**
 * 把历史格式的键（`店名|地点`）归一到纯店名。**幂等**，可以随便调。
 * 判据是「含不含 `|`」—— 老格式必然带它，新的纯店名和小类键（`food:苹果`）都不带。
 * （店名自身含 `|` 的老数据本来就分不出前半段是店名还是名字的一部分，取第一段，
 *   接受这点损失：那种数据在两个方案下都是错的分组。）
 */
function normStoreKey(key) {
  const s = String(key == null ? '' : key);
  const i = s.indexOf('|');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/**
 * 一条订单的店铺键。**分组 / 筛选 / 统计一律走这里，别直读 o.storeKey** ——
 * 老订单里存的仍是 `店名|城市`，直接读会把同一家店拆成两堆。
 * 缺 storeKey 的坏数据（手工改过的备份）回落到店名；两者都没有时给空串，
 * 由调用方兜成「未命名店铺」，不让它把列表页整页掀翻。
 */
function orderKeyOf(o) {
  if (!o) return '';
  const k = (o.storeKey == null || o.storeKey === '') ? (o.storeName || '') : o.storeKey;
  return normStoreKey(k);
}

/**
 * 一家店「用过 / 配过」的消费方式，去重且保序。
 * 两个来源都要：已保存的配置（用户显式维护的） + 历史订单里出现过的值。
 * 后半截是**老订单的兜底** —— v3.0 之前没有这份配置，全靠订单上的 channel
 * 现推，否则编辑一条旧单时那一格会是空的、一保存就把原来的值丢了。
 */
function channelsOfStore(key) {
  const k = normStoreKey(key);
  const saved = storeMeta[k] && Array.isArray(storeMeta[k].channels) ? storeMeta[k].channels : [];
  const hist = (_lastOrders || []).filter((o) => orderKeyOf(o) === k).map((o) => o.channel);
  const out = [];
  for (const v of saved.concat(hist)) {
    const t = String(v == null ? '' : v).trim();
    if (t && out.indexOf(t) === -1) out.push(t);
  }
  return out;
}

/**
 * 把「支持的消费方式」那格重画成已选标签。
 * 顺序就是用户添加的顺序（不排序）：这是他自己定的清单，按字典序重排反而陌生。
 */
function renderSupChannels() {
  const box = $('#sup-channel-box');
  if (!box) return;
  box.innerHTML = supChannels.map((v) => `<span class="sup-chip">${esc(v)}` +
    `<button type="button" class="sup-x" data-supdel="${esc(v)}" aria-label="移除">×</button></span>`).join('');
  box.hidden = !supChannels.length;
}

/** 添加一个支持项。空值 / 重复值静默忽略（重复时把已有的那项当结果，不报错）。 */
function addSupChannel(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return false;
  if (supChannels.indexOf(v) === -1) {
    supChannels.push(v);
    renderSupChannels();
    return true;
  }
  return false;
}

function removeSupChannel(v) {
  const i = supChannels.indexOf(v);
  if (i === -1) return;
  supChannels.splice(i, 1);
  renderSupChannels();
}

/**
 * 把「实际消费方式」当前的值**沉淀**进该店的清单（v3.0.2 的核心关系）。
 *
 * 触发点：实际消费方式那格失焦 / 提交订单。没店名时什么都不做 ——
 * 清单是店铺属性，没有店名就没有载体。
 * 返回 true 表示清单真的变了（调用方据此重绘候选）。
 */
function absorbChannelIntoStore() {
  if (!storeNameOf()) return false;
  const v = readChannel();
  if (!v || supChannels.indexOf(v) !== -1) return false;
  supChannels.push(v);
  renderSupChannels();
  return true;
}

/**
 * 换店时把支持清单换成那家店的。`force=true` 用于回填（编辑旧单 / 恢复草稿）。
 *
 * 不用「每次输入都刷」：用户可能先手动加了两项再去补店名，实时刷会把他刚加的
 * 冲掉。所以只在**店铺身份真的变了**（或显式 force）时才换，靠 supForKey 判断。
 *
 * **换之前先把用户当前填着的值保住**：现在的录入顺序是先填「实际消费方式」
 * 再填店名，这里若直接整份覆盖，用户刚打进去的值会凭空消失 ——
 * 而那时他多半不会再回头看一眼那一格（v3.0.1 的 E-03 就是这么丢值的）。
 */
function loadSupForStore(force) {
  const key = storeKeyOf(storeNameOf());
  if (!force && key === supForKey) return;
  supForKey = key;
  const keep = readChannel();
  supChannels = channelsOfStore(key);
  if (keep && supChannels.indexOf(keep) === -1) supChannels.unshift(keep);
  renderSupChannels();
  // 店名变了可能连带改掉表单形态（支持块显隐 / 平台显隐 / 小类评价），顺手重算一次。
  // 放在这里而不是各个调用点，是因为 goReview / 编辑旧单 / 草稿恢复都要它。
  applyFormMode();
}

/**
 * 只在「清单还是空的」时候去补一次。
 *
 * 补这一次是必须的：店名那格只在 change（失焦）时才触发加载，而用户完全可以
 * 一路不点别处直接把整单填完按保存 —— 那时清单还是空的，会漏掉这家店早就配好的支持项，
 * 看着像「填过的东西丢了」。
 * 反过来，用户已经手动加过项就绝不去动它（union/覆盖都可能把他刚加的清掉）。
 */
function ensureSupLoaded() {
  if (supChannels.length) return;
  loadSupForStore(true);
}

// ---------- 「实际消费方式」 ----------
// v3.0.2 起**只有一种形态**：输入框 + 页内历史候选，和地点 / 平台 / 小类同一套。
// v3.0 那版「有店名就换成下拉、且只能从店铺清单里选」已经取消 ——
// 现在的录入顺序是先填实际消费方式、后填店铺，那时清单还不存在，
// 让它当那个闸门只会把用户卡在「请先添加支持的消费方式」上。
// 清单反过来由这一格沉淀（见 absorbChannelIntoStore）。
//
// 候选来自两处（见 renderSuggestAll）：该店已记录的清单（有店名时）+ 该大类历史值。
// 数据库键仍然是 channel，改 key 会让已有订单和旧备份导入后丢值。

/** 读「实际消费方式」的当前值。**统一走这里**，别在别处直读 #channel-text。 */
function readChannel() {
  const t = $('#channel-text');
  return t ? String(t.value || '').trim() : '';
}

/** 写「实际消费方式」。 */
function setChannel(v) {
  const t = $('#channel-text');
  if (t) t.value = String(v == null ? '' : v).trim();
}

/**
 * 危险操作的统一二次确认（点两次才真正执行）。
 * 刻意不用原生 confirm()：WebView 的 onJsConfirm 依赖宿主实现，
 * 被屏蔽时整个删除逻辑会静默返回 false，表现为「点了没反应」。
 * 纯 DOM 事件在任何环境都可靠。
 */
function armConfirm(btn, opts) {
  if (btn.dataset.arm !== '1') {
    btn.dataset.arm = '1';
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = opts.ask;
    btn.classList.add('arming');
    toast(opts.hint);
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.dataset.arm = '0';
      btn.textContent = btn.dataset.label;
      btn.classList.remove('arming');
    }, 3000);
    return;
  }
  clearTimeout(btn._t);
  btn.disabled = true;
  btn.textContent = opts.busy;
  // 复位按钮这件事**成功失败都要做**。只在失败分支里做的话，那些不在重绘区里的
  // 按钮（#clear-all 就住在统计页的静态区块里）会永久停在「清空中…」+ disabled：
  // 再点没反应，用户从此清不掉数据，而界面上没有任何线索。
  const reset = () => {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || '重试';
    btn.dataset.arm = '0';
    btn.classList.remove('arming');
  };
  opts.run()
    .then(() => {
      toast(opts.done);
      reset();
      // 单独接住：刷新失败不该被误报成「操作失败」
      refreshAll().catch((e) => toast('列表刷新失败：' + (e && e.message ? e.message : '未知错误')));
    })
    .catch((err) => {
      reset();
      alert('操作失败：' + (err && err.message ? err.message : '存储被占用，请重启应用后重试'));
    });
}

// ---------- 图片全屏查看（图集模式） ----------
// 同一个店铺卡片里的图去重后组成一组，可以箭头 / 左右横滑翻页。
// 去重是必须的：卡片顶部的缩略图条和展开后的每条订单评价渲染的是同一批图，
// 不去重的话翻到第二遍就会看到重复内容，用户会以为图重复存了。
let lbList = [];
let lbIndex = 0;
let lbSwiped = false;   // 刚横滑过，用来吃掉紧随其后的那次 click

/**
 * 以被点的图为起点，收集它所在店铺卡片里的全部图片。
 * 靠 DOM 现取而不是在模板里预先编号：卡片重绘后编号会失效，
 * 而 querySelectorAll 永远跟着当前 DOM 走。
 */
function collectGallery(imgEl) {
  const store = imgEl.closest ? imgEl.closest('.store') : null;
  const scope = store || document;
  const seen = new Set();
  const list = [];
  scope.querySelectorAll('.zoomable').forEach((n) => {
    const s = n.getAttribute('src');
    if (s && !seen.has(s)) { seen.add(s); list.push(s); }
  });
  if (!list.length) list.push(imgEl.getAttribute('src'));
  return list;
}

function openLightbox(src, list) {
  if (!src) return;
  lbList = (list && list.length) ? list : [src];
  const i = lbList.indexOf(src);
  lbIndex = i >= 0 ? i : 0;
  paintLightbox();
  $('#lightbox').hidden = false;
}

function paintLightbox() {
  $('#lightbox-img').src = lbList[lbIndex];
  const multi = lbList.length > 1;
  $('#lb-prev').hidden = !multi;   // 只有一张时箭头纯属噪音
  $('#lb-next').hidden = !multi;
  $('#lb-count').textContent = multi ? (lbIndex + 1) + ' / ' + lbList.length : '';
}

function lbStep(d) {
  if (lbList.length < 2) return;
  // 首尾循环，不用翻到头再往回走
  lbIndex = (lbIndex + d + lbList.length) % lbList.length;
  paintLightbox();
}

function closeLightbox() {
  const lb = $('#lightbox');
  if (lb.hidden) return;
  lb.hidden = true;
  // 清掉 src：dataURL 是完整的 base64 大图，留着会一直占内存
  $('#lightbox-img').src = '';
  lbList = [];
}

// ---------- 工具 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// n 先夹到 0~5 再切片：越界时 slice 会把另一边补成负数下标（'★★★★★'.slice(0,6)
// 还是 5 星，但 '☆☆☆☆☆'.slice(0,-1) 只给 4 个空心）—— 结果是 9 个字符的怪东西。
const stars = (n) => {
  const k = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★★★★★'.slice(0, k) + '☆☆☆☆☆'.slice(0, 5 - k);
};

// 读文件为 dataURL（FileReader 在部分 WebView 上需要 file:// 白名单，见 MainActivity.kt）
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader 读取失败'));
    reader.readAsDataURL(file);
  });
}

// ---------- 图片裁剪 ----------
// 系统裁剪（ACTION_CROP）不是标准 API：各 ROM 支持的 extras 不一致，
// 还会跟 SAF 返回的 content:// URI 打架。所以裁剪在页面内用 canvas 自己做，跨机型一致。
const CROP_MAXDIM = 1280;
const CROP_MIN = 44;

function openCropper(src) {
  return new Promise((resolve) => {
    const root = $('#cropper');
    const stage = $('#crop-stage');
    const img = $('#crop-img');
    const boxEl = $('#crop-box');
    const zoomEl = $('#crop-zoom');
    const uploadBox = $('#upload-box-dish'); // 裁剪期间就地替换掉它，避免两处同时显示
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    let st = null;
    let drag = null;

    const stagePt = (e) => {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    // 图片在 stage 中的可见范围，同时作为裁剪框的合法边界
    const imageBounds = () => {
      const s = st.fit * st.zoom;
      return {
        loX: Math.max(0, st.ox),
        hiX: Math.min(st.sw, st.ox + st.iw * s),
        loY: Math.max(0, st.oy),
        hiY: Math.min(st.sh, st.oy + st.ih * s),
      };
    };

    const draw = () => {
      const s = st.fit * st.zoom;
      img.style.transform = `translate(${st.ox}px, ${st.oy}px) scale(${s})`;
      boxEl.style.left = st.box.x + 'px';
      boxEl.style.top = st.box.y + 'px';
      boxEl.style.width = st.box.w + 'px';
      boxEl.style.height = st.box.h + 'px';
    };

    // 把裁剪框内的原图区域编码成 jpeg dataURL
    const encode = (sx, sy, sw, sh) => {
      const k = Math.min(1, CROP_MAXDIM / Math.max(sw, sh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * k));
      c.height = Math.max(1, Math.round(sh * k));
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      // src 是 dataURL（同源），正常不会污染 canvas；真失败就交回原图，不让用户丢图
      try { return c.toDataURL('image/jpeg', 0.85); } catch (e) { return null; }
    };

    // 当前裁剪框对应的原图坐标，clamp 到图片内避免取到黑边
    const boxToSrc = () => {
      const s = st.fit * st.zoom;
      const sx = clamp((st.box.x - st.ox) / s, 0, Math.max(0, st.iw - 1));
      const sy = clamp((st.box.y - st.oy) / s, 0, Math.max(0, st.ih - 1));
      return {
        sx, sy,
        sw: clamp(st.box.w / s, 1, st.iw - sx),
        sh: clamp(st.box.h / s, 1, st.ih - sy),
      };
    };

    const onDown = (e) => {
      const h = e.target.closest('.crop-h');
      const inBox = e.target.closest('#crop-box');
      const p = stagePt(e);
      if (h) drag = { mode: 'resize', h: h.dataset.h, p, box: { ...st.box } };
      else if (inBox) drag = { mode: 'move', p, box: { ...st.box } };
      else drag = { mode: 'pan', p, ox: st.ox, oy: st.oy };
      if (e.cancelable) e.preventDefault();
    };

    const onMove = (e) => {
      if (!drag) return;
      const p = stagePt(e);
      const dx = p.x - drag.p.x;
      const dy = p.y - drag.p.y;

      if (drag.mode === 'pan') {
        st.ox = drag.ox + dx;
        st.oy = drag.oy + dy;
      } else {
        const b = imageBounds();
        if (drag.mode === 'move') {
          st.box.x = clamp(drag.box.x + dx, b.loX, Math.max(b.loX, b.hiX - drag.box.w));
          st.box.y = clamp(drag.box.y + dy, b.loY, Math.max(b.loY, b.hiY - drag.box.h));
        } else {
          const n = { ...drag.box };
          if (drag.h.includes('w')) {
            const nx = clamp(n.x + dx, b.loX, n.x + n.w - CROP_MIN);
            n.w = n.x + n.w - nx;
            n.x = nx;
          }
          if (drag.h.includes('e')) n.w = clamp(n.w + dx, CROP_MIN, b.hiX - n.x);
          if (drag.h.includes('n')) {
            const ny = clamp(n.y + dy, b.loY, n.y + n.h - CROP_MIN);
            n.h = n.y + n.h - ny;
            n.y = ny;
          }
          if (drag.h.includes('s')) n.h = clamp(n.h + dy, CROP_MIN, b.hiY - n.y);
          st.box = n;
        }
      }
      draw();
      if (e.cancelable) e.preventDefault();
    };

    const onUp = () => { drag = null; };

    const close = (result) => {
      root.hidden = true;
      if (uploadBox) uploadBox.hidden = false; // 裁剪结束，把上传框还原
      stage.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };

    $('#crop-cancel').onclick = () => close(null);
    $('#crop-done').onclick = () => {
      const r = boxToSrc();
      close(encode(r.sx, r.sy, r.sw, r.sh) || src);
    };

    // 缩放以裁剪框中心为锚点，保证框里的内容不跑偏
    zoomEl.oninput = () => {
      if (!st) return;
      const nz = Number(zoomEl.value) / 100;
      const oldS = st.fit * st.zoom;
      const newS = st.fit * nz;
      const ax = st.box.x + st.box.w / 2;
      const ay = st.box.y + st.box.h / 2;
      const px = (ax - st.ox) / oldS;
      const py = (ay - st.oy) / oldS;
      st.zoom = nz;
      st.ox = ax - px * newS;
      st.oy = ay - py * newS;
      draw();
    };

    img.onload = () => {
      // 必须先显示再量尺寸：hidden 时 clientWidth/clientHeight 是 0
      root.hidden = false;
      if (uploadBox) uploadBox.hidden = true; // 就地换成裁剪区，不是跳到另一个页面
      root.scrollIntoView({ block: 'center' }); // 展开后滚到可见位置，省得用户自己找

      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const sw = stage.clientWidth || 1;
      const sh = stage.clientHeight || 1;
      // fit 保证图片完整放进 stage，初始裁剪框 = 整张图
      const fit = Math.min(sw / iw, sh / ih);
      st = {
        iw, ih, sw, sh, fit, zoom: 1,
        ox: (sw - iw * fit) / 2,
        oy: (sh - ih * fit) / 2,
        box: { x: 0, y: 0, w: 0, h: 0 },
      };
      const b = imageBounds();
      st.box = {
        x: b.loX,
        y: b.loY,
        w: Math.max(CROP_MIN, b.hiX - b.loX),
        h: Math.max(CROP_MIN, b.hiY - b.loY),
      };
      zoomEl.value = '100';
      draw();
    };
    img.onerror = () => close(null);

    stage.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // 触摸被系统打断时不会走 pointerup，不兜住会卡住 drag 状态
    window.addEventListener('pointercancel', onUp);

    // 必须先清掉旧 src：再选同一张图时 dataURL 字符串完全相同，
    // 浏览器不会重新触发 load，裁剪界面就永远弹不出来（表现为"点了没反应"）
    img.removeAttribute('src');
    img.src = src;
  });
}

// 选图 → 裁剪 → dataURL。返回 null 表示用户取消。
async function pickImage(file) {
  const raw = await readAsDataURL(file);
  return openCropper(raw);
}

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------- 表单 ----------
let pendingDishImage = null;
let pendingEditOrder = null; // 编辑中的原订单，null 表示新增
const DRAFT_KEY = 'waimai_draft';

/**
 * 计量方式：份数 / 重量。
 *
 * 为什么加这个：有人买的是「几份」（外卖套餐），有人买的是「几斤」
 * （水果、散装熟食）。这两种东西不能塞进同一个「人均」里算 ——
 * 2.5 斤和 2 人完全不是一回事，混在一起均价会失去意义。
 *
 * 落地上**只加一个 unit 字段**，不动任何已有键：
 *   - weight 模式写 unit:'jin'
 *   - pieces 模式不写（或写 'fen'）
 *   - `people` 这个键在重量模式下复用为「购买斤数」。
 *     复用而不新增键，是为了老备份/老订单**原样可用** —— 它们没有 unit，
 *     一律按 pieces 走（见 isJin 的注释），不需要任何迁移代码。
 *   - 每斤均价 / 人均都**不存库**，一律现算，避免两处口径打架。
 */
const UNIT = { PIECES: 'fen', WEIGHT: 'jin' };

/** 这一单是不是按斤计价。**没有 unit 字段的老订单一律当份数** —— 这是
 *  「老数据不用迁移」的全部秘密，改这个判断等于要写迁移。 */
const isJin = (o) => !!o && o.unit === UNIT.WEIGHT;

/** 表单当前选中的计量方式（由按钮点击维护，见 bindForm 里的 data-unit 委托） */
let formUnit = UNIT.PIECES;

/**
 * 三个大类：餐饮 / 生鲜 / 零食。
 *
 * 这张表是**唯一的数据源** —— 段选按钮和计量方式的默认值都从它派生，
 * 将来加第四类只改这一处。
 * （v2.9 起「小类」不再有预置词条，所以这里没有 words 表了 —— 别加回来，
 *   理由见 renderSuggest 上面那段。）
 *
 * 为什么餐饮走份数、生鲜零食走重量：吃一顿饭比的是「人均」，买两斤水果比的是
 * 「每斤均价」，两套口径不能混在一个数里（见 splitByUnit 的注释）。
 * 但大类**只负责给默认值**：选完仍然可以手动改 —— 有人按包买零食，
 * 一包薯片 6 块钱，锁死重量模式会让他连单都录不进去。
 *
 * `cls` 是统计卡上那个小色标的类名，三个颜色刻意跟「份数(绿) / 重量(琥珀)」
 * 错开 —— 那两张卡的口径不同，颜色一样会让人当成一套数看。
 */
const CATEGORY = { MEAL: '餐饮', FRESH: '生鲜', SNACK: '零食' };

const CATEGORIES = [
  { name: CATEGORY.MEAL,  cls: 'cat-meal',  unit: UNIT.PIECES },
  { name: CATEGORY.FRESH, cls: 'cat-fresh', unit: UNIT.WEIGHT },
  { name: CATEGORY.SNACK, cls: 'cat-snack', unit: UNIT.WEIGHT },
];

/**
 * 一单属于哪个大类。**没有 category 字段的老订单一律算「餐饮」** ——
 * 和 isJin 同一个思路：新字段只加不迁移，读的时候兜底，老备份 / 老草稿原样能用。
 * 认不出来的值（手改备份写错了）也一并回落，免得统计卡上凭空多出一行
 * 谁也不认识的分类。
 */
const catOf = (o) => {
  const c = o && o.category;
  return CATEGORIES.some((x) => x.name === c) ? c : CATEGORY.MEAL;
};

/** 按名字取大类定义，认不出来回落第一个（餐饮） */
function categoryDef(name) {
  return CATEGORIES.filter((c) => c.name === name)[0] || CATEGORIES[0];
}

/** 表单当前选中的大类 */
let formCategory = CATEGORY.MEAL;

/** 每斤均价 = 总价 / 斤数。缺失或非正数时返回 null（调用方显示「—」而不是 NaN）。 */
function jinPrice(total, jin) {
  const t = parseFloat(total), j = parseFloat(jin);
  if (!isFinite(t) || !isFinite(j) || j <= 0) return null;
  return t / j;
}

/** 一单的「单位价」文本：份数给人均，重量给每斤。缺失时不给数字。 */
function unitPriceText(o) {
  if (isJin(o)) {
    const v = jinPrice(o.totalPrice, o.people);
    return v === null ? '每斤 —' : `每斤¥${v.toFixed(1)}`;
  }
  const p = parseFloat(o.people);
  if (!isFinite(p) || p <= 0) return '人均 —';
  return `人均¥${(o.totalPrice / p).toFixed(1)}`;
}

/** 数量描述：「2人」/「2.5斤」。斤数去掉无意义的小数尾巴（3.0 → 3）。 */
function qtyText(o) {
  const n = parseFloat(o.people);
  if (isJin(o)) return `${isFinite(n) ? trimNum(n) : '?'}斤`;
  return `${isFinite(n) ? trimNum(n) : '?'}人`;
}

/** 3 -> '3'，2.50 -> '2.5'，2.34 -> '2.34'（最多两位小数）。 */
function trimNum(n) {
  return String(Math.round(Number(n) * 100) / 100);
}

/**
 * 按计量方式把一堆订单分成两桶并各自算指标。
 *
 * 分桶是「分开统计」的核心：份数桶给 count/总额/均价/人均，
 * 重量桶给 count/总额/均价/每斤均价。**两桶的钱和单量是能相加的**（金额与单位无关），
 * 但「人均」和「每斤均价」永远不能相加 —— 所以卡片上分两行显示，不合并成一个数。
 */
function splitByUnit(list) {
  const of = (rows) => {
    if (!rows.length) return null;
    const sumTotal = rows.reduce((s, o) => s + o.totalPrice, 0);
    const sumQty = rows.reduce((s, o) => s + (parseFloat(o.people) || 0), 0);
    return {
      count: rows.length,
      sumTotal,
      avgPrice: sumTotal / rows.length,
      sumQty,
      // 份数桶 = 人均（总价÷人数）；重量桶 = 每斤均价（总价÷斤数）
      perUnit: sumQty > 0 ? sumTotal / sumQty : null,
    };
  };
  return {
    fen: of(list.filter((o) => !isJin(o))),
    jin: of(list.filter((o) => isJin(o))),
  };
}

/**
 * 读「综合评价」那一格的分数。
 *
 * 用 Number 而不是 parseInt（老写法）—— 订单合并会产出 4.5 这种平均分，
 * parseInt 会把它截成 4，用户只是点一下「保存修改」就把合并结果吃掉了。
 * 配套的滑杆 step 在 index.html 里放成了 0.1，否则小数根本回填不进去
 * （range 会把 4.5 吸附到最近的合法档位）。
 */
function readRating() {
  const v = Number($('#rating').value);
  // 空值 / 非数回落 5：滑杆的 HTML 默认值就是 5，读不到说明表单刚被 reset 过
  if (!isFinite(v) || v <= 0) return 5;
  // 留一位小数：既是滑杆的精度，也是「评分取平均」之后要展示的精度
  return Math.round(Math.max(1, Math.min(5, v)) * 10) / 10;
}

function readForm() {
  return {
    storeName: $('#storeName').value,
    city: $('#city').value,
    platform: $('#platform').value,
    category: formCategory,
    foodType: $('#foodType').value,
    channel: readChannel(),
    // 草稿要带上支持清单：用户可能刚加了两项就点了「暂存」，
    // 不带的话恢复草稿时那一格会退回成历史值推出来的样子
    supportedChannels: supChannels.slice(),
    items: $('#items').value,
    totalPrice: $('#totalPrice').value,
    people: $('#people').value,
    unit: formUnit,
    rating: $('#rating').value,
    review: $('#review').value,
    dishImage: pendingDishImage,
    orderDate: $('#orderDate').value,
  };
}

function writeForm(d) {
  if (!d) return;
  // 小类评价那格马上要被整张覆盖，先把「当前是哪一段」清掉 ——
  // 不清的话 refreshFoodNote 会把上一张表单残留在 textarea 里的文字
  // 当成待保存内容，写进上一个小类的评价里。
  foodNoteName = ''; foodNoteLoaded = '';
  $('#storeName').value = d.storeName || '';
  $('#city').value = d.city || '';
  $('#platform').value = d.platform || '';
  // 支持清单要在写实际消费方式之前定下来 —— 它是那格的候选来源之一。
  // 草稿里带着用户自己那份；编辑旧单 / 老备份里没有，就从这家店的历史订单现推
  // （channelsOfStore）。两者都基于**店名**算出来的 storeKey（v3.0.2 起不含地点）。
  const key = storeKeyOf(d.storeName);
  supForKey = key;
  supChannels = Array.isArray(d.supportedChannels) && d.supportedChannels.length
    ? d.supportedChannels.slice()
    : channelsOfStore(key);
  // 这一单原先记着的值必须能选到：v3.0 之前的老订单，它的 channel 不一定出现在
  // 上面推出来的清单里，补进去而不是让它在回填时凭空消失（等于把数据吃掉）。
  if (d.channel && supChannels.indexOf(d.channel) === -1) supChannels.unshift(d.channel);
  renderSupChannels();
  // 大类必须先设：它决定「小类」那一格的候选桶和计量方式的默认值。
  // 传 false 是**回填路径**，不清任何已存的值 —— 编辑一条旧单时
  // 把 foodType 清掉就等于吃数据。老订单没有 category，catOf 一律兜成餐饮，
  // 这里 d.category 是 undefined 时同样回落到餐饮。
  setFormCategory(d.category, false);
  $('#foodType').value = d.foodType || '';
  // 形态要在小类和店名都写完之后再定一次：上面那次 setFormCategory 跑的时候
  // foodType 还是空的，小类评价那格会被判成「没有小类」而收起。
  applyFormMode();
  // 实际消费方式只有一种形态，原样带过去 —— 历史值不受店铺清单约束
  setChannel(d.channel || '');
  $('#items').value = d.items || '';
  $('#totalPrice').value = d.totalPrice || '';
  $('#people').value = d.people || '1';
  // 老草稿 / 老备份里没有 unit，回落到份数模式
  setFormUnit(d.unit === UNIT.WEIGHT ? UNIT.WEIGHT : UNIT.PIECES);
  $('#rating').value = d.rating || '5';
  $('#rating-val').textContent = d.rating || '5';
  $('#review').value = d.review || '';
  // 老草稿 / 老备份里没有 orderDate 时**回填订单自身的日期**，不是「今天」。
  // 以前这里写的是 dayKey(Date.now())，于是编辑一条几天前的老单、只改个价格，
  // 日期就被悄悄改成了今天，而且没有任何提示。date 才是订单真正记着的时间。
  $('#orderDate').value = d.orderDate || dayKey(Number(d.date) || Date.now());
  pendingDishImage = d.dishImage || null;
  const previewDish = $('#preview-dish'), pickDish = $('#pick-dish-btn');
  if (pendingDishImage) { previewDish.src = pendingDishImage; previewDish.hidden = false; pickDish.hidden = true; }
  else { previewDish.hidden = true; pickDish.hidden = false; }
  // 回填完再重绘标签：编辑一条老订单时，标签应该只留下和它同类的那几个
  renderSuggestAll();
}

function resetForm() {
  $('#order-form').reset();
  pendingDishImage = null; pendingEditOrder = null;
  // 支持清单是**店铺级**的，跟着表单一起清干净：不清的话，上一条单子那家店的
  // 支持项会留在下一张空白表单里，看着像用户已经填过了。
  supChannels = []; supForKey = '';
  // 小类评价同理。这里**故意直接丢弃**不去落库 —— 调用方要么刚存过
  // （提交订单），要么本来就打算清干净（清除暂存 / 从待点评转正）。
  // foodNoteName 不清的话，下一张空白表单会带着上一个小类的评价，
  // 而且 applyFormMode 会以为「还没换过小类」而不去重读。
  foodNoteName = ''; foodNoteLoaded = '';
  renderSupChannels();
  // reset() 会把 date 输入框清空（它的 HTML 默认值是空），必须补回今天
  $('#orderDate').value = dayKey(Date.now());
  const previewDish = $('#preview-dish'), pickDish = $('#pick-dish-btn');
  previewDish.hidden = true; previewDish.src = ''; pickDish.hidden = false;
  $('#rating-val').textContent = '5';
  // 回落到「餐饮 + 份数」。setFormCategory 内部会顺带把计量方式设成该类默认值
  setFormCategory(CATEGORY.MEAL, false);
  const sb = $('#submit-btn'); if (sb) sb.textContent = '保存订单';
  renderSuggestAll();
}

function hasDraft() {
  try { return !!localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
}
function saveDraft() {
  // 草稿里带着 base64 图片，而 localStorage 配额通常只有几 MB，**很容易超**。
  // setItem 抛 QuotaExceededError 时原来会直接冒出去，
  // 后面的横幅和 toast 都不执行 —— 表现就是「点了暂存草稿毫无反应」，连原因都看不到。
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(readForm()));
  } catch (e) {
    const quota = e && (e.name === 'QuotaExceededError' || e.code === 22);
    toast(quota ? '暂存失败：本地存储空间不足，去掉图片再试' : '暂存失败：' + (e && e.message ? e.message : '未知错误'));
    return;
  }
  showDraftBanner(true);
  toast('已暂存草稿');
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* 存储不可用时忽略 */ }
  showDraftBanner(false);
}
function showDraftBanner(on) { $('#draft-banner').hidden = !on; }

/**
 * 切换计量方式：按钮高亮 + 那一格的标签/输入约束 + 实时均价。
 *
 * 份数模式沿用原来的 min=1/step=1（人数是整数）；
 * 重量模式必须放开成 step=0.01 —— 沿用 step=1 的话输入框会拒绝 2.5，
 * 而 parseInt 的老兜底更糟，会把 2.5 直接截成 2。
 *
 * `clearQty=true` 才清数量，表示这是**用户主动切换** —— 份数的「2 人」
 * 带到重量模式变成「2 斤」是错的，留着比清掉更容易让人以为已经改过了。
 * 回填路径（编辑旧单 / 恢复草稿）必须传 false：那时 people 刚被 writeForm
 * 写成真值，再清一次就把数据吃了 —— 编辑一条「3 人」的单子回来会变成「1 人」，
 * 编辑一条「2.5 斤」的单子回来会变成空。v2.6 起的写法一直是无条件清，
 * 直到这次加「大类自动切模式」才暴露出来。
 */
function setFormUnit(u, clearQty) {
  formUnit = u === UNIT.WEIGHT ? UNIT.WEIGHT : UNIT.PIECES;
  const jin = formUnit === UNIT.WEIGHT;
  $$('.seg-btn[data-unit]').forEach((b) => b.classList.toggle('on', b.dataset.unit === formUnit));
  const lab = $('#people-label');
  if (lab) lab.textContent = jin ? '购买斤数（斤）' : '用餐人数';
  const peo = $('#people');
  if (peo) {
    peo.min = jin ? '0.01' : '1';
    peo.step = jin ? '0.01' : '1';
    peo.placeholder = jin ? '如：2.5' : '';
    if (clearQty) peo.value = jin ? '' : '1';
  }
  renderUnitOut();
}
function renderUnitOut() {
  const box = $('#unit-out');
  if (!box) return;
  if (formUnit !== UNIT.WEIGHT) { box.textContent = ''; box.hidden = true; return; }
  box.hidden = false;
  const v = jinPrice($('#totalPrice').value, $('#people').value);
  box.textContent = v === null ? '每斤均价 —' : `每斤均价 ¥${v.toFixed(2)}`;
}

/**
 * 切换大类：餐饮 / 生鲜 / 零食。
 *
 * 做四件事：高亮按钮 → 把计量方式切到该大类的默认值 → 换掉下面那几格的
 * 历史候选 → 重绘。三格的候选是**一起**换的（syncHist 走 HIST_FIELDS），
 * 所以这里重绘全部而不是只重绘小类 —— 平台那格不重绘的话，切到生鲜后
 * 下面还摆着「美团」，看着像没切。
 *
 * `userAction=true` 表示这是**用户点的**（而不是回填草稿 / 编辑旧单），
 * 此时额外清掉已填的东西：「小类」里的「午餐」留在生鲜类下是错的，
 * 数量也不能跨模式带过去（0.5 人 / 0.5 斤都不是用户想要的）。
 * 回填路径必须传 false —— 那些值是用户自己存下来的，清掉等于把数据吃了。
 * 注意只清小类，**不清地点/平台/消费方式**：那三格是想跨类复用的
 * （今天在生鲜类下还是从哈尔滨买的），清掉等于每切一次就要重打一遍。
 */
function setFormCategory(name, userAction) {
  formCategory = categoryDef(name).name;
  $$('.seg-btn[data-cat]').forEach((b) => b.classList.toggle('on', b.dataset.cat === formCategory));
  // 大类只给默认单位，真实单位永远以订单里的 unit 为准（writeForm 随后会覆盖）
  setFormUnit(categoryDef(formCategory).unit, !!userAction);
  if (userAction) {
    const inp = $('#foodType');
    if (inp) inp.value = '';
  }
  // 历史值换一份：餐饮的「午餐」不该在生鲜类里当候选，餐饮的「美团」同理
  syncHist();
  // 候选整组换掉了必须重绘 —— 不重绘的话，点完大类看到的还是上一类的标签
  renderSuggestAll();
  // 形态放在最后算：它要读已经定下来的大类，以及上面刚被清掉的小类
  // （小类评价那格会顺手把还没落库的文字存掉，见 refreshFoodNote）
  applyFormMode();
}

// ---------- 表单形态（随大类 / 店名联动） ----------
/**
 * 表单的「形态」集中算一次：哪几格该出现、哪一格必填、实际消费方式用哪个控件。
 *
 * 它同时取决于**大类**和**店名是否已填**，所以必须只写这一处 —— 由
 * setFormCategory 和店名输入事件一起调。散开写必漏（这个项目已经吃过
 * 「逐个绑监听会随重绘丢掉」的亏）。
 *
 * **幂等**：没变化时什么都不做（尤其不搬值），所以可以放心挂在每个 input 事件上。
 */
function applyFormMode() {
  const sn = $('#storeName');
  const named = !!String((sn && sn.value) || '').trim();

  // ① 店铺名称：**完全选填**（v3.0.2 起，餐饮也不再强制）。
  //    星号元素留着（#store-req），恒隐藏 —— 它是显隐钩子，将来要恢复必填只改这一行。
  if (sn) sn.required = false;
  const star = $('#store-req');
  if (star) star.hidden = true;

  // ② 支持的消费方式：**店铺属性**，挂在 storeKey 上 —— 没店名就没有载体，整块收起。
  //    只是「收起」，**不清 supChannels**：用户删掉店名又填回来的话，刚配的还在。
  const supField = $('#sup-field');
  if (supField) supField.hidden = !named;

  // ③ 平台：**实际消费方式是「线下」时不出现** —— 线下吃没有平台可言。
  //    判据用精确相等，不做模糊匹配：这个词是用户自己填的，写成「含线下」
  //    会把「线下外卖柜」这种本来可能有平台的场景也一起藏掉。
  const pf = $('#platform-field');
  if (pf) pf.hidden = readChannel() === '线下';

  // ④ 小类评价：只有非餐饮才有「小类」这个分组维度（refreshFoodNote 里判）
  refreshFoodNote(false);
}

// ---------- 小类评价（归属小类的一段记录） ----------
// 键 = 'food:' + 小类名，**和列表页的分组键同一个值**（见 FOOD_GROUP_PREFIX），
// 所以卡片拿着 g.key 就能直接读写它。
// **按小类名全局共享**：所有店铺共用，生鲜和零食也共用 —— 在录单页改了它，
// 等于改了所有「苹果」的评价。这是产品上的既定语义，不是 bug。
//
// **即时保存**（失焦 / 切小类 / 提交订单时落库），刻意不跟订单走：
// 列表页的小类卡片上也能改它，两边都攒草稿的话必然互相覆盖，而用户看不出发生过什么。
let foodNoteName = '';    // 这格当前对应的小类名（trim 后）
let foodNoteLoaded = '';  // 上一次从库里读出来的值，用来判断「用户改过没有」

/** 把「小类评价」切到某个小类：读库、填进 textarea。 */
function loadFoodNote(name) {
  const n = String(name == null ? '' : name).trim();
  foodNoteName = n;
  const m = n ? storeMeta[FOOD_GROUP_PREFIX + n] : null;
  foodNoteLoaded = (m && m.note) || '';
  const ta = $('#food-note');
  if (ta) ta.value = foodNoteLoaded;
}

/**
 * 把 textarea 里还没落库的内容写掉；没改过就什么都不做。
 *
 * 注意 `foodNoteLoaded` 要在 await **之前**更新：这中间来一次 refreshFoodNote，
 * 会把同一段文字再存一遍（顺序错了还会存到刚切过去的那个小类上）。
 */
async function saveFoodNoteIfDirty() {
  const name = foodNoteName;
  const ta = $('#food-note');
  if (!name || !ta) return;
  const text = ta.value.trim();
  if (text === foodNoteLoaded) return;
  foodNoteLoaded = text;
  const key = FOOD_GROUP_PREFIX + name;
  try {
    await writeNoteRow(key, text, 'food');
    // 卡片上如果还挂着同一个键的编辑草稿，以刚落库的这份为准 ——
    // 否则它会把旧文字显示出来，用户一按保存又盖回去
    delete noteDraft[key];
  } catch (err) {
    toast('小类评价保存失败：' + (err && err.message ? err.message : '存储被占用，请重启应用后重试'));
  }
}

/**
 * 重算「小类评价」那格的显隐，并在小类变了的时候换一份内容。
 *
 * 只有非餐饮 + 小类非空才显示 —— 餐饮按店铺分组，小类不是分组维度，
 * 没有卡片能挂这段评价；小类都没填就更谈不上评价谁。
 *
 * **收起或换小类之前一定要先把没落库的改动写掉**：这格是即时保存的，
 * 但用户完全可能打完字不失焦、直接切大类或者改小类名。
 */
function refreshFoodNote(force) {
  const field = $('#food-note-field');
  if (!field) return;
  const n = String(($('#foodType') || {}).value || '').trim();
  const show = formCategory !== CATEGORY.MEAL && !!n;
  // 小类被改过（或者这格要收起）→ 先把上一个小类的改动落库。
  // foodNoteName 为空说明表单刚被整张覆盖过（writeForm / resetForm），
  // 那时 textarea 里是上一张单子的残留，不能存 —— 由 saveFoodNoteIfDirty 自己挡掉。
  if (!show || n !== foodNoteName) saveFoodNoteIfDirty();
  field.hidden = !show;
  if (!show) return;
  if (force || n !== foodNoteName) loadFoodNote(n);
}

// ---------- 字段标签（纯历史值，替代原生 datalist） ----------
// 平台和类型原本挂的是原生 <datalist>，它在 Android WebView 里会被渲染成
// 一个**原生下拉浮层**，浮层紧贴输入法上方。候选只剩一个时几乎必然挡住键盘，
// 连正常输入都做不到（用户实测：候选只有一个时打不了字）。
// 换成页面内的标签后完全不经过原生控件：输入法不受任何干扰，选项再多也只是
// 多几行标签，而且可以直接点选。地点因此获得了「用过一次就能选」的能力，
// 消费方式当时靠预置标签兜住原来那三个写死的选项（那份预置 v2.7.2 也取消了）。
// v2.5：v2.4 的「外卖种类」改名「类型」，字段名仍是 foodType。
// v2.7：界面上叫「细分类」（字段名照旧），候选跟着「大类」走。
// v2.7.1：**四格的历史候选全部按大类分开**（原来只有细分类分了）。
// v2.9：界面名再改成「小类」（字段名仍是 foodType），且**预置词条全部取消** ——
//       这一格跟地点 / 平台 / 消费方式彻底同构，候选只有历史值。
// v3.0：消费方式一度**退出这一套**了 —— 它改名「实际消费方式」并降级成 <select>，
//       可选值由**店铺的「支持的消费方式」**决定，跟历史值无关，所以那版把
//       HIST_FIELDS 缩到了三格。
// v3.0.1：它**又回来了**。生鲜/零食的单可以不填店名，那时没有店铺清单可依，
//       那一格退回自由输入 + 历史候选（和地点/平台/小类同一套）。
//       所以 HIST_FIELDS 是**四格**。注意它的容器是 #sug-channel-text ——
//       「#sug-channel」是更早那版自由输入用的 id，现在的输入框叫 channel-text
//       （channel 这个 id 归下拉），别照名字猜。
let histValues = { city: [], platform: [], channel: [], foodType: [] };

/** 有历史候选的字段。**这张表是唯一数据源** —— refreshHistory / syncHist /
 *  渲染都从它派生。以后再加一格带候选的输入框，只改这一处，
 *  别去别的地方再抄一份字段名（抄漏一格的表现是「那格永远没候选」，不报错）。 */
const HIST_FIELDS = ['city', 'platform', 'channel', 'foodType'];

/**
 * 历史值**按大类分开存两层**：`histByCategory[字段][大类] = [值…]`。
 * 例如 `histByCategory.platform['生鲜']` 只有盒马/叮咚，
 * `histByCategory.platform['餐饮']` 只有美团/饿了么 —— 两边的候选不互相串。
 *
 * histValues 只放「当前大类」那一份，由 syncHist 换进来（见下）。
 * 分开的理由：这四个字段的取值都**跟着买菜场景走**。混在一起时，
 * 在生鲜类下打「盒」会先联想出餐饮类的平台，而那一单根本不可能用盒马以外的东西。
 */
let histByCategory = {};

/**
 * **「小类」这一格没有任何预置词条，候选只有历史值。**
 *
 * v2.7 曾经按大类给过预置（餐饮给餐次、生鲜零食给品类），由 CATEGORIES 的
 * words 表驱动。v2.9 全部取消 —— 用户的原话是「只用历史记录」。
 *
 * 取消的两个理由：一是用户没点过的词也占着候选位，二是它会**看起来像历史** ——
 * 一个从没主动打过的「线下吃」和真用过的「麻辣烫」并排摆着，看久了就分不清
 * 哪些是自己攒下来的。现在候选区里的每一个值都必然是他自己的输入。
 *
 * 代价接受得了：第一次录某个小类得手打。但打过一次就常驻可选，而且这一格
 * 本来就允许自由输入（v2.5.1 起放开），没有白名单卡着。
 *
 * 名称同时从「细分类」改成「小类」，跟「大类」构成上下两级 ——
 * 预置没了之后，「细分类」那三个字里的「分类」就只剩大类一个来源了。
 *
 * **别再给它加回预置**：verify_apk.py 的 marker 里 presetsFor 已经移除，
 * 加回来会让解包校验直接失败。
 */

// 按使用次数排序：常用的排前面，比按拼音排有用得多
function historyOf(orders, key) {
  const count = new Map();
  for (const o of orders) {
    const v = String(o[key] || '').trim();
    if (v) count.set(v, (count.get(v) || 0) + 1);
  }
  return [...count.keys()].sort((a, b) => (count.get(b) - count.get(a)) || a.localeCompare(b, 'zh'));
}

/**
 * 刷新缓存并重绘所有标签行。数据变了（保存 / 删除 / 导入）都要调一次。
 *
 * `wishList` 是可选的第二个数据源：待点评里记过的地点 / 小类也算「用过的值」，
 * 录单时应该能直接点选。**合并必须在按大类分桶之前完成**（先并成同一个数组），
 * 别去 histByCategory 上做二次合并 —— 那个结构是派生出来的，
 * 顺序错了会被紧随其后的 syncHist / 下一轮 refreshHistory 覆盖掉。
 *
 * 代价要知道：wish 对象身上没有 platform / channel 两个键，所以那两格的候选
 * 不受待点评影响（historyOf 读不到值就是空，不会污染），这是预期行为。
 */
function refreshHistory(orders, wishList) {
  const all = (orders || []).concat(wishList || []);
  // 每个字段都按大类分开攒：先按大类把订单切一遍，再在每一堆里数历史值。
  // 老订单没有 category → catOf 一律兜成「餐饮」，所以它们的历史值全落在
  // 餐饮那一份里，不会凭空造出第四个分类。
  histByCategory = {};
  for (const f of HIST_FIELDS) {
    const byCat = {};
    for (const c of CATEGORIES) {
      byCat[c.name] = historyOf(all.filter((o) => catOf(o) === c.name), f);
    }
    histByCategory[f] = byCat;
  }
  histValues = {};
  syncHist();
  renderSuggestAll();
}

/**
 * 把「当前大类」那一份历史值换进 histValues。
 * 数据变化后和**切换大类时**都要调 —— 不调的话，在生鲜类下输入框下面
 * 会挂着餐饮类的词：小类里联想出「水煮鱼」，平台那格一直摆着「美团」，
 * 而这两样在生鲜单里都用不上。
 */
function syncHist() {
  for (const f of HIST_FIELDS) {
    histValues[f] = (histByCategory[f] || {})[formCategory] || [];
  }
}

// 候选总数上限。v2.9 起只数历史值（预置没了，不占名额），8 个已经很够用，
// 再多会把表单顶得太长。
const SUGG_MAX = 8;

function renderSuggest(inputId, key, prepend) {
  const box = $('#sug-' + inputId), input = $('#' + inputId);
  if (!box || !input) return; // 老版 HTML 里没有这个容器时静默跳过，别把整页拖崩
  const typed = String(input.value || '').trim().toLowerCase();
  // 候选池 = 额外来源（`prepend`，如「实际消费方式」要并进该店的支持清单）
  //        + 该大类的历史值，去重且保序。
  // 候选**每一个都参与「边打边筛」**：v2.9 取消预置词条后这几格同构，没有例外
  //（地点 / 平台 / 实际消费方式 / 小类四格）。
  const pool = [];
  for (const v of [].concat(prepend || [], histValues[key] || [])) {
    const t = String(v == null ? '' : v).trim();
    if (t && pool.indexOf(t) === -1) pool.push(t);
  }
  const list = pool
    .filter((v) => !typed || v.toLowerCase().indexOf(typed) !== -1)
    .slice(0, SUGG_MAX);
  box.innerHTML = list.map((v) => {
    // 完全匹配的那个标成选中态，而不是像以前那样藏起来 ——
    // 藏掉它，输入框里已有的值会让候选区一个都不剩，想改反而没入口。
    const on = (typed && v.toLowerCase() === typed) ? ' on' : '';
    return `<button type="button" class="sug-chip${on}" data-sug-for="${inputId}" data-sug-value="${esc(v)}">${esc(v)}</button>`;
  }).join('');
  box.hidden = !list.length;
}

// 下单日期的快捷标签。当前日期命中哪个就高亮哪个。
const DATE_QUICK = [[0, '今天'], [1, '昨天'], [2, '前天']];
function dayOffsetValue(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset); // 用 setDate 而不是减 86400000，夏令时/月长都不用操心
  return dayKey(d.getTime());
}
function renderDateQuick() {
  const box = $('#sug-date'), input = $('#orderDate');
  if (!box || !input) return;
  const cur = input.value;
  box.innerHTML = DATE_QUICK.map(([off, label]) => {
    const v = dayOffsetValue(off);
    return `<button type="button" class="sug-chip${cur === v ? ' on' : ''}"` +
      ` data-sug-for="orderDate" data-sug-value="${v}">${label}</button>`;
  }).join('');
  box.hidden = false;
}

/**
 * 输入框 id → 历史桶键的映射。
 *
 * 「实际消费方式」的输入框 id 是 `channel-text`，而数据库字段名（也是历史桶名）
 * 是 `channel` —— 两者对不上是历史原因，**别去改任何一边**：改 id 会连带改
 * 一堆静态检查标记，改字段名会让存量订单丢值。
 * 取键的地方一律走这个映射，抄成两份的表现是「候选永远空」，不报错。
 */
function suggKeyOf(inputId) { return inputId === 'channel-text' ? 'channel' : inputId; }

/** 「实际消费方式」的额外候选来源：这家店已经记录过的支持清单（没店名时没有）。 */
function suggPrependFor(inputId) {
  return (inputId === 'channel-text' && storeNameOf()) ? supChannels : null;
}

function renderSuggestAll() {
  renderSuggest('city', 'city');
  renderSuggest('platform', 'platform');
  // 多一个来源：该店的支持清单。理由同上（顺序上它在店名之前填，
  // 所以「这家店常怎么吃」多半得在这里才看得见）
  renderSuggest('channel-text', suggKeyOf('channel-text'), suggPrependFor('channel-text'));
  renderSuggest('foodType', 'foodType');
  renderDateQuick();
}

// 'YYYY-MM-DD' + 参考时刻的时分秒 → 时间戳。
// 选今天就等于当前时刻；选别的日期则沿用当前钟点，否则一天里的订单
// 全挤在 00:00，同一天内的先后顺序就没了。
// 返回 null 表示格式不认（原生日历控件不可用时用户可以手输，得留条退路）。
function dayValueToTs(dayValue, baseTs) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dayValue || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  const d = new Date(y, mo - 1, da);
  // 反查一遍：2026-02-31 会被 Date 静默滚成 3 月 3 日，必须自己拦掉
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  const b = new Date(baseTs);
  d.setHours(b.getHours(), b.getMinutes(), b.getSeconds(), 0);
  return d.getTime();
}

// ---------- 导入 / 导出 ----------
// 导出备份。
// APK 内必须走原生桥：WebView 对 <a download> + blob: 是**静默忽略**的
// （没设 DownloadListener，blob: 也不能交给 DownloadManager），
// 而页面还会照常弹「已导出」—— 是假成功，文件根本没落盘。
async function exportData() {
  const orders = await getAll();
  const wishRows = await getAllWishes();
  // 「一条订单都没有」不再等于「没东西可导」—— 只攒了想吃的、还没去吃过的人
  // 也应该能导出清单。这个提前返回是加待点评时最容易漏的一处（还要改 importData）。
  if (!orders.length && !wishRows.length) { toast('还没有记录，没什么可导出的'); return; }
  // v2 备份格式：外层包一个信封，把店铺整体评价一起带上。
  // v3 起再加 wishes（待点评清单）。
  // 老版是「纯数组、只有订单」，导入那边两种都认（见 parseBackup），
  // 所以升级后导出的文件依然能读回订单 —— 反过来的单向兼容见 parseBackup 的注释。
  // metas 里**故意**带着小类评价（'food:' 那批）—— 备份要能整份带走，导入那边
  // 也是按 key 原样写回，不需要区分归属。
  const metas = Object.keys(storeMeta).map((k) => storeMeta[k]);
  const json = JSON.stringify({
    app: 'waimai-pingjia',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    orders,
    storeMeta: metas,
    wishes: wishRows,
  }, null, 2);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `waimai-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  // storeMeta 里混着两种归属，计数**必须分开数** —— 混着数会把小类评价报成
  // 「店铺评价 N 条」。另外只配了支持项、没写评价的店也会占一行，
  // 所以数的是**真写了评价的**行，不是行数。
  const noteCount = storeMetaRows('store').filter((m) => m && m.note).length;
  const foodNoteCount = storeMetaRows('food').filter((m) => m && m.note).length;
  const noteTip = noteCount ? `，店铺评价 ${noteCount} 条` : '';
  const foodTip = foodNoteCount ? `，小类评价 ${foodNoteCount} 条` : '';
  const wishTip = wishRows.length ? `，待点评 ${wishRows.length} 条` : '';

  const bridge = window.AndroidBridge;
  if (bridge && typeof bridge.export === 'function') {
    let r = '';
    try {
      r = String(bridge.export(name, json)); // 同步调用，原生写进系统「下载」目录
    } catch (err) {
      toast('导出失败：' + (err && err.message ? err.message : '桥接异常'));
      return;
    }
    if (r.indexOf('OK:') === 0) toast(`已导出 ${orders.length} 条${noteTip}${foodTip}${wishTip} → ${r.slice(3)}`);
    else toast('导出失败：' + r.replace(/^ERR:/, ''));
    return;
  }

  // 浏览器环境：走原生下载
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`已导出 ${orders.length} 条${noteTip}${foodTip}${wishTip}`);
}

// 导入备份。
// 与导出**不是**同一条链路：导出要原生桥（WebView 没有下载宿主），
// 导入走的是文件选择器 —— 宿主就是 onShowFileChooser，v1.2 已经补上。
// v1.6 及以前这里也是坏的：`hidden` input + 程序化 .click() 被 WebView 静默忽略，
// 表现就是「点导入按钮毫无反应」，和当初图片上传是同一个坑。
function looksLikeOrder(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) &&
    (o.storeName || o.storeKey || (o.id && o.rating !== undefined));
}

/**
 * 解析备份文本 → { rows, metas, wishes }；解析不出来返回 { error }。
 *
 * 三种格式都认，向后兼容是刻意留的 —— 用户手机里可能还存着升级前导出的备份：
 *   老版（≤v2.4）= 纯数组，只有订单
 *   新版（v2.5~v2.7）= { app, version, orders, storeMeta } 信封
 *   新版（≥v2.8）= 上面那个信封再加 wishes
 * 三个分支都给全 rows / metas / wishes，调用方就不用到处写 `|| []`。
 *
 * **单向兼容**：v2.8 导出的备份丢给 v2.7.2 及更老的 APK 会导入失败
 * （老代码只认 orders/storeMeta，wishes 那一段它看不见，但如果它做了严格校验
 * 就会直接报错）。这是既有约定，不是新问题。
 *
 * 单独抽成函数是为了**能测**：这段分支埋在原地的 FileReader 回调里的话，
 * 冒烟测试根本够不着，只能靠人肉点。
 */
function parseBackup(text) {
  let data;
  try {
    // 记事本等编辑器另存会带 UTF-8 BOM，JSON.parse 遇到它是直接抛语法错误的
    data = JSON.parse(String(text == null ? '' : text).replace(/^\uFEFF/, ''));
  } catch (e) {
    return { error: '文件格式错误：不是合法 JSON' };
  }
  if (Array.isArray(data)) return { rows: data, metas: [], wishes: [] };
  if (data && Array.isArray(data.orders)) {
    return {
      rows: data.orders,
      metas: Array.isArray(data.storeMeta) ? data.storeMeta : [],
      // 老备份里没有 wishes，'wishes': 'nope' 这种垃圾值也要当空数组，
      // 别让一个字段的类型问题把整份备份拦下来
      wishes: Array.isArray(data.wishes) ? data.wishes : [],
    };
  }
  return { error: '不是有效的备份文件（应为 JSON 数组，或含 orders 字段的对象）' };
}

function importData(file, onDone) {
  const reader = new FileReader();
  reader.onload = async () => {
    // async 回调里抛错不会冒泡到 addEventListener，不接住就是静默失败
    try {
      // 格式判别（含 BOM 处理）都在 parseBackup 里，见那边的注释
      const parsed = parseBackup(reader.result);
      if (parsed.error) { toast(parsed.error); return; }
      const rows = parsed.rows;
      const metas = parsed.metas;
      const wishRows = parsed.wishes;
      // 两份都空才算「没记录」—— 只导过待点评清单的备份也要能进来
      if (!rows.length && !wishRows.length) { toast('备份文件里没有记录'); return; }

      const filtered = rows.filter(looksLikeOrder);
      const skipped = rows.length - filtered.length;
      if (!filtered.length && !wishRows.length) { toast('备份文件里没有可识别的记录'); return; }

      let existing;
      try { existing = new Set((await getAll()).map((o) => o.id)); }
      catch (e) { existing = new Set(); }

      // 计数必须在 map 的同步阶段完成：put 是异步的，之后再数就错位了
      let added = 0, updated = 0;
      const results = await Promise.allSettled(filtered.map((o, i) => {
        if (!o.id) o.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + i);
        // 店铺键 = 纯店名（v3.0.2 起地点不参与身份）。老备份里的 `店名|城市`
        // 不必在这里特判 —— orderKeyOf 会归一，而它同时也是分组/统计的口径。
        o.storeKey = orderKeyOf(o);
        if (!o.date || !isFinite(Number(o.date))) o.date = Date.now();
        // 总价 / 评分必须是数字：手工改过的备份里可能是字符串，而字符串会让
        // 后面的 reduce 退化成拼接（'0'+'20'+'30' → '02030'），越界评分还会污染均分。
        const tp = parseFloat(o.totalPrice);
        o.totalPrice = (isFinite(tp) && tp >= 0) ? tp : 0;
        const rt = parseInt(o.rating, 10);
        o.rating = (isFinite(rt) && rt >= 1 && rt <= 5) ? rt : 0;
        // 老备份里没有 unit。**刻意不补默认值** —— 缺字段本身就是「份数模式」的
        // 表达（见 isJin），补一个 'fen' 进去反而会让「这是老数据」这个信息
        // 在导出时被抹掉，以后想区分就再也分不出来了。
        // 数量兜底：老数据一定有 people；万一没有，按 1 处理，别让卡片显示 NaN。
        if (!(parseFloat(o.people) > 0)) o.people = 1;
        if (existing.has(o.id)) updated++; else added++;
        return putOrder(o);
      }));

      // 用 allSettled 而非 all：批量写里坏一条不该让整体报「失败」，
      // 那样用户既不知道进去了几条，也不知道到底哪一步出了问题
      let failed = results.filter((r) => r.status === 'rejected').length;

      // 店铺整体评价 / 小类评价：一条一条按 storeKey 覆盖写。
      // 只认带 storeKey 的条目 —— 缺了它就没法定位是哪家店，存进去也是孤儿数据。
      // **键要归一**（v3.0.2）：老备份里存的是 `店名|城市`，而现在的身份是纯店名；
      // 顺便把 kind 补上，归属从此不再靠键前缀猜（见 kindOfRow）。
      const metaRows = metas.filter((m) => m && typeof m === 'object' && m.storeKey)
        .map((m) => {
          const raw = String(m.storeKey);
          const food = isFoodMetaKey(raw);
          return Object.assign({}, m, {
            storeKey: food ? raw : normStoreKey(raw),
            kind: food ? 'food' : 'store',
          });
        });
      // 归一之后**同一个键可能撞到一起**（老备份按 `店名|城市` 分行）。
      // 不折叠的话就是「谁最后 put 谁赢」，而这里是并行写、先后不确定 ——
      // 用 mergeMetaRow 折叠，口径就和读取时（indexMeta）完全一致了。
      const metaByKey = new Map();
      for (const m of metaRows) {
        const prev = metaByKey.get(m.storeKey);
        metaByKey.set(m.storeKey, prev ? mergeMetaRow(prev, m) : m);
      }
      const metaRowsOut = [...metaByKey.values()];
      let metaWritten = 0;
      if (metaRowsOut.length) {
        const mr = await Promise.allSettled(metaRowsOut.map((m) => {
          if (typeof m.note !== 'string') m.note = '';
          if (!m.updatedAt) m.updatedAt = Date.now();
          // v3.0：店铺的「支持的消费方式」跟着 storeMeta 一起走。
          // 老备份（≤v2.9）里没有 channels 字段 —— 这时**保留本地已有的清单**，
          // 而不是写一个空数组进去：整行覆盖会让用户在 app 里维护好的支持清单
          // 被一份旧备份悄悄抹掉，而备份看起来还没问题。
          const prev = storeMeta[m.storeKey];
          if (Array.isArray(m.channels)) {
            m.channels = m.channels.map((x) => String(x).trim()).filter(Boolean);
          } else if (prev && Array.isArray(prev.channels)) {
            m.channels = prev.channels;
          } else {
            delete m.channels;
          }
          return putMeta(m);
        }));
        metaWritten = mr.filter((x) => x.status === 'fulfilled').length;
        failed += mr.filter((x) => x.status === 'rejected').length;
      }

      // 待点评：按 id upsert。只认有 id 的条目，而且**至少得有一个说得出的内容** ——
      // 缺 id 没法定位；什么都没有的记录存进去只是垃圾。
      // 店名不再是硬条件了：生鲜/零食的待点评允许不填名称（和订单表单同一条规矩）。
      const wishOk = wishRows.filter((w) => w && typeof w === 'object' && w.id
        && (w.storeName || w.foodType || w.want));
      let wishWritten = 0;
      if (wishOk.length) {
        const wr = await Promise.allSettled(wishOk.map((w) => {
          if (!w.createdAt) w.createdAt = Date.now();
          // priority 只认 1/2/3，别的值一律落到「想吃」——
          // 卡片上的胶囊是按这个数字取文案的，越界会渲染成 undefined
          if (!(w.priority >= 1 && w.priority <= 3)) w.priority = 2;
          return putWish(w);
        }));
        wishWritten = wr.filter((x) => x.status === 'fulfilled').length;
        failed += wr.filter((x) => x.status === 'rejected').length;
      }

      await refreshAll();
      if (failed && !added && !updated && !metaWritten && !wishWritten) {
        toast(`导入失败：${failed} 条全部写入出错`);
        return;
      }
      const parts = [];
      if (added) parts.push(`新增 ${added} 条`);
      if (updated) parts.push(`覆盖 ${updated} 条`);
      if (metaWritten) parts.push(`店铺评价 ${metaWritten} 条`);
      if (wishWritten) parts.push(`待点评 ${wishWritten} 条`);
      if (skipped) parts.push(`跳过 ${skipped} 条无法识别`);
      if (failed) parts.push(`失败 ${failed} 条`);
      toast('导入完成：' + parts.join('，'));
    } catch (e) {
      toast('导入失败：' + (e && e.message ? e.message : '未知错误'));
    }
  };
  reader.onerror = () => toast('文件读取失败');
  // 清空 input 要等读完再做：读取途中清 value 有可能让 WebView 提前释放
  // content:// 的临时读取授权，readAsText 就会失败。
  // （图片那条路径也是在 await 之后才清 value，这里原来是不一致的。）
  reader.onloadend = () => { if (onDone) onDone(); };
  reader.readAsText(file);
}

function bindForm() {
  // 图片选择器：两条路径都要绑，防止某条在特定 WebView 上失灵
  //   ① <label for> 原生关联 —— WebView 里最稳的唤起方式
  //   ② 按钮 click → input.click() 兜底（部分实现 label 转发不生效）
  const wirePicker = (input, trigger, preview, assign) => {
    trigger.addEventListener('click', (ev) => {
      const lab = trigger.closest('label');
      if (lab && lab.htmlFor === input.id) return; // 原生 label 已负责，别重复触发
      ev.preventDefault();
      input.click();
    });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      toast('正在读取图片…');
      try {
        const out = await pickImage(f);   // null = 用户取消了裁剪
        if (!out) return;
        if (out.length > 2_500_000) { toast('图片过大，请裁剪小一点或换一张'); return; }
        assign(out);
        preview.src = out;                // 之前漏了这行，导致预览图不刷新
        preview.hidden = false;
        trigger.hidden = true;
      } catch (err) {
        toast('图片处理失败：' + (err && err.message ? err.message : '未知错误'));
      } finally {
        input.value = ''; // 允许重复选同一张图（否则 change 不再触发）
      }
    });
  };

  wirePicker($('#dish'), $('#pick-dish-btn'), $('#preview-dish'), (v) => { pendingDishImage = v; });

  $('#rating').addEventListener('input', (e) => { $('#rating-val').textContent = e.target.value; });

  // 大类 / 计量方式 / 支持消费方式：挂在表单上而不是各自按钮上 —— 这些控件的
  // 状态会被 setFormCategory / setFormUnit / renderSupChannels 反复重绘
  // （回填草稿、编辑旧单、重置表单），逐个绑容易漏一处。共用这一个委托，
  // 按各自的钩子分流。顺序有意义：#sup-channel-add 排在 seg-btn 前面，
  // 否则它会被当成普通按钮走空。
  $('#order-form').addEventListener('click', (e) => {
    if (e.target.closest('#sup-channel-add')) {
      const inp = $('#sup-channel-in');
      addSupChannel(inp && inp.value);
      if (inp) inp.value = '';   // 清空好接着加下一个
      return;
    }
    const supDel = e.target.closest('[data-supdel]');
    if (supDel) { removeSupChannel(supDel.getAttribute('data-supdel')); return; }
    const c = e.target.closest('.seg-btn[data-cat]');
    if (c) { setFormCategory(c.dataset.cat, true); return; }
    const b = e.target.closest('.seg-btn[data-unit]');
    if (!b) return;
    // 用户手动切模式同样要清数量（份数的「2 人」变成「2 斤」是错的）
    setFormUnit(b.dataset.unit, true);
  });

  // 支持项输入框回车即添加 —— 手机上比折回去点那个按钮顺手。
  // 必须 preventDefault：不拦的话回车会顺手把整张表单提交出去，
  // 用户会看到「请填写店铺名称和总价」这种莫名其妙的提示。
  const supIn = $('#sup-channel-in');
  if (supIn) {
    supIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.cancelable) e.preventDefault();
      addSupChannel(e.target.value);
      e.target.value = '';
    });
  }
  // 换店（店名变了）就把支持清单换成那家店的。用 change 而不是 input：
  // 边打字边换会在用户还没打完店名时就把他手动加的项冲掉。
  // **地点不在这条绑定里** —— v3.0.2 起店铺身份只看店名，改地点不再等于换店。
  const storeInp = $('#storeName');
  if (storeInp) {
    storeInp.addEventListener('change', () => loadSupForStore(false));
    // 店名一变就重算表单形态（支持块显隐 / 平台显隐 / 小类评价显隐）。
    // 用 input 而不是 change：形态是**看得见**的东西，等失焦才变会显得卡住。
    // 而「换支持清单」仍然走 change（见上）—— 两件事分开是对的，别合并。
    storeInp.addEventListener('input', () => applyFormMode());
  }

  // 实际消费方式：边打边筛候选 + 重算平台显隐；**失焦时把这个值沉淀进该店清单**
  // （v3.0.2 的核心关系：店铺的支持清单是从这一格攒出来的）。
  const chInp = $('#channel-text');
  if (chInp) {
    chInp.addEventListener('input', () => {
      renderSuggest('channel-text', suggKeyOf('channel-text'), suggPrependFor('channel-text'));
      applyFormMode();
    });
    chInp.addEventListener('change', () => { absorbChannelIntoStore(); renderSuggestAll(); });
  }

  // 小类变了 → 小类评价那格跟着换（顺便把上一个小类的改动落库）
  const foodInp = $('#foodType');
  if (foodInp) foodInp.addEventListener('input', () => refreshFoodNote(false));

  // 小类评价：失焦即落库。用 change 而不是 input —— 每敲一个字写一次库会开出
  // 一串写事务，而这段文字本来就是「打完才作数」的。
  const foodNoteEl = $('#food-note');
  if (foodNoteEl) foodNoteEl.addEventListener('change', () => { saveFoodNoteIfDirty(); });

  // 总价 / 斤数一变就重算每斤均价。两个都监听：用户先填斤数还是先填总价都行。
  ['#totalPrice', '#people'].forEach((sel) => {
    $(sel).addEventListener('input', renderUnitOut);
  });

  $('#draft-save').addEventListener('click', saveDraft);
  $('#draft-clear').addEventListener('click', () => { clearDraft(); resetForm(); toast('已清除暂存'); });

  $('#order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const storeName = $('#storeName').value.trim();
    const city = $('#city').value.trim();
    const total = parseFloat($('#totalPrice').value);
    // 店铺名称**完全选填**（v3.0.2 起，餐饮也不再强制）：填了才有店铺这层归属，
    // 不填的单子照样进列表（生鲜/零食按小类分组，餐饮落进「未命名店铺」）。
    // 地点同样选填，而且**不参与店铺身份** —— 身份只看店名。
    if (!(total >= 0)) { toast('请填写总价'); return; }
    // 实际消费方式是**必填**，只有一种形态（自由输入 + 历史候选）。
    const channel = readChannel();
    if (!channel) { toast('请填写实际消费方式'); return; }
    // 支持的消费方式：**店铺属性**，有店名才存在、才有必填一说。
    // 顺序上它在实际消费方式之后，所以这里现补一次：
    //   ① ensureSupLoaded —— 用户可能一路没让店名那格失焦过，先把该店已有的清单捞回来
    //   ② absorbChannelIntoStore —— 再把这一单填的实际消费方式沉淀进清单
    let supList = [];
    if (storeName) {
      ensureSupLoaded();
      absorbChannelIntoStore();
      supList = supChannels.slice();
      if (!supList.length) { toast('请填写这家店支持的消费方式'); return; }
    }
    // 斤数必须 parseFloat：parseInt 会把 2.5 斤截成 2 斤，而这是用户真正输的数。
    // 而且**不能**套份数那边 Math.max(1, ...) 的兜底 —— 那个兜底在为空的斤数上
    // 会凭空造出「1 斤」，算出一张根本不存在的每斤均价。缺就是缺，交给 unitPriceText 显示「—」。
    const rawQty = parseFloat($('#people').value);
    if (formUnit === UNIT.WEIGHT) {
      if (!(rawQty > 0)) { toast('请填写购买斤数'); return; }
    }
    const people = formUnit === UNIT.WEIGHT
      ? rawQty
      : Math.max(1, parseInt($('#people').value, 10) || 1);
    const editing = pendingEditOrder;
    // 编辑时以原订单的时间为基准，这样「只改价格不改日期」不会顺手把时分秒也改掉
    const baseTs = editing ? editing.date : Date.now();
    const dayValue = $('#orderDate').value;
    const pickedTs = dayValue ? dayValueToTs(dayValue, baseTs) : null;
    if (dayValue && pickedTs === null) { toast('购买日期认不出来，点一下日期框重新选'); return; }
    // 用 dayKey 比，而不是直接比字符串：手输的 '2026-9-20' 和 '2026-09-20'
    // 在字符串序上是反的，只有归一到日期才不会误判
    if (pickedTs !== null && dayKey(pickedTs) > dayKey(Date.now())) {
      toast('购买日期不能晚于今天'); return;
    }
    // 身份只看店名（地点是「这次在哪买」，不是这家店的定义）
    const storeKey = storeName;
    const order = {
      id: editing ? editing.id : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
      storeName, city,
      platform: $('#platform').value,
      category: formCategory,
      foodType: $('#foodType').value,
      // 实际消费方式：上面已经校验过它一定在 supList 里
      channel,
      items: $('#items').value.trim(),
      totalPrice: total,
      people,
      // 份数模式也显式写 'fen'：新单子一律带 unit，读的时候就不用猜
      unit: formUnit,
      rating: readRating(),
      review: $('#review').value.trim(),
      dishImage: pendingDishImage,
      // 以前这里写死 Date.now()，只能记下"保存的那一刻"，补录前几天的订单是做不到的
      date: pickedTs === null ? baseTs : pickedTs,
      storeKey,
    };
    // 支持清单和订单**在同一个事务里**落库。分两次写的话：订单进去了、配置没进去，
    // 下次录同一家店时那一格会退回历史值推出来的样子 —— 用户刚维护好的清单凭空消失。
    // storeMeta 那行按 key 合并（note 留在原地，别把它覆盖掉），并**显式写上
    // kind:'store'** —— 归属自 v3.0.2 起靠这个字段判定，不再靠键前缀（见 kindOfRow）。
    // **没填店名时不碰 storeMeta**：没有归属的清单写进去只是垃圾。
    const metaRow = storeName
      ? Object.assign({}, storeMeta[storeKey] || {}, {
          storeKey, kind: 'store', channels: supList, updatedAt: Date.now(),
        })
      : null;
    // 小类评价是即时保存的，但用户完全可能一路没让那格失焦就直接按保存 —— 补一次
    await saveFoodNoteIfDirty();
    // 原来这里没有 try/catch：写库失败时 async 监听器静默 reject，
    // 表单原样留着、没有任何提示，看起来就是「点了保存没反应」。
    // 凡是 await 之后的成功提示，都必须先确认 await 真的成功了。
    try {
      await txWriteIn([STORE, STORE_META], (tx) => {
        tx.objectStore(STORE).put(order);
        if (metaRow) tx.objectStore(STORE_META).put(metaRow);
      });
    } catch (err) {
      toast('保存失败：' + (err && err.message ? err.message : '存储被占用，请重启应用后重试'));
      return;
    }
    if (metaRow) storeMeta[storeKey] = metaRow;
    clearDraft();
    resetForm();
    // 从「待点评」转正过来的单子：保存成功后**按 id 精确删**掉那条待点评。
    // 放在这里而不是 goReview 里：用户可能改了主意直接保存别的单子，
    // 那时 pendingWishId 已经被 banner 的「取消」清掉了，不该误删。
    let extra = '';
    if (pendingWishId) {
      const wid = pendingWishId;
      pendingWishId = null;
      showWishBanner('');
      try {
        await deleteWish(wid);
        wishes = wishes.filter((w) => w.id !== wid);
        extra = '（已从待点评移除）';
      } catch (err) {
        // 订单**已经写进去了**，这里失败只影响清单 —— 不能因此说「保存失败」，
        // 否则用户会以为白录一次又重来一遍，反而写出第二条重复订单
        toast('订单已保存，但待点评没删掉：' + (err && err.message ? err.message : '未知错误'));
      }
    }
    toast((editing ? '已更新' : '已保存') + extra);
    switchView('stores'); // 切回店铺页会触发 refreshAll，不用在这里重复刷一遍
  });
}

// ---------- 待点评表单 ----------
// 待点评自己的大类。**和订单表单的 formCategory 是两套独立状态** ——
// 用户可能正在录一张生鲜的单，同时想存一条餐饮的待点评。
let wishCategory = CATEGORY.MEAL;

/**
 * 待点评表单的候选标签（地点 / 小类）。复用订单表单那份历史值
 * （histByCategory），但按 **wishCategory** 取，不是 formCategory ——
 * 两边的 seg 是独立的控件，共用一个大类状态会互相串。
 * 标签复用订单表单的 data-sug-for / data-sug-value 钩子，
 * 所以两边走的是同一个点击处理器（applySugChip）。
 */
function renderWishSugg(inputId, key, boxId) {
  const box = $('#' + boxId), input = $('#' + inputId);
  if (!box || !input) return;
  const typed = String(input.value || '').trim().toLowerCase();
  // 两格都只有历史值（v2.9 起小类的预置也取消了）—— 和订单表单同一条规矩
  const list = ((histByCategory[key] || {})[wishCategory] || [])
    .filter((v) => !typed || v.toLowerCase().indexOf(typed) !== -1)
    .slice(0, SUGG_MAX);
  box.innerHTML = list.map((v) => {
    const on = (typed && v.toLowerCase() === typed) ? ' on' : '';
    return `<button type="button" class="sug-chip${on}" data-sug-for="${inputId}"` +
      ` data-sug-value="${esc(v)}">${esc(v)}</button>`;
  }).join('');
  box.hidden = !list.length;
}
function renderWishSuggAll() {
  renderWishSugg('w-city', 'city', 'w-sug-city');
  renderWishSugg('w-type', 'foodType', 'w-sug-type');
}

/** 待点评表单的形态。名称自 v3.0.2 起**完全选填**，和订单表单的「店铺名称」
 *  同一条规矩（餐饮也不再强制）—— 攒「想吃什么」时只记得「楼下那家」，
 *  也允许先记下来。星号元素保留、恒隐藏，留作显隐钩子。
 *  别和订单表单的 applyFormMode 合并 —— 那是**另一个 form**，字段集只有一半，
 *  消费方式两格和小类评价它都没有。 */
function applyWishMode() {
  const n = $('#w-name');
  if (n) n.required = false;
  const star = $('#w-req');
  if (star) star.hidden = true;
}

/** 把待点评表单恢复成「刚打开」的样子：清空输入 + 大类回餐饮 + 心动度回「想吃」 */
function resetWishForm() {
  const f = $('#wish-form');
  if (f) f.reset();
  wishCategory = CATEGORY.MEAL;
  $$('.seg-btn[data-wcat]').forEach((b) => b.classList.toggle('on', b.dataset.wcat === wishCategory));
  $$('.seg-btn[data-wpri]').forEach((b) => b.classList.toggle('on', b.dataset.wpri === '2'));
  applyWishMode();
  renderWishSuggAll();
}

/**
 * 候选标签点击：把值填进对应输入框，再重绘那一格（高亮换到刚选中的标签上）。
 * 订单表单和待点评表单共用这一条路径 —— 两边的 form 都委托到这里。
 * 刻意**不做失焦收起**：那会先 blur 再 click，标签还没被点到就被藏起来，
 * 手机上等于点不动（和店铺备注输入框同一个坑）。
 */
function applySugChip(chip) {
  const input = $('#' + chip.dataset.sugFor);
  if (!input) return;
  input.value = chip.dataset.sugValue || '';
  if (input.id === 'orderDate') renderDateQuick();
  else if (input.id === 'w-city' || input.id === 'w-type') renderWishSuggAll();
  else renderSuggest(input.id, suggKeyOf(input.id), suggPrependFor(input.id));
  // **程序化赋值不会派发事件**，所以这两个副作用得在这里补上 ——
  // 少了它们，同一个动作「手输」和「点标签」的表现就不一样（v3.0.1 的 E-01）：
  //   点「小类」→ 小类评价那格不出现；点「实际消费方式」→ 平台显隐不更新
  if (input.id === 'foodType') refreshFoodNote(false);
  if (input.id === 'channel-text') applyFormMode();
}

function bindWishForm() {
  const form = $('#wish-form');
  if (!form) return;
  // 折叠开关：待点评表单不占 tab，点「＋ 添加想吃的」就地展开
  const toggle = (on) => {
    form.hidden = !on;
    const btn = $('#w-add');
    if (btn) btn.textContent = on ? '收起表单' : '＋ 添加想吃的';
  };
  $('#w-add').addEventListener('click', () => toggle(form.hidden));
  $('#w-cancel').addEventListener('click', () => toggle(false));

  // 大类 / 心动度 / 候选标签：一个委托全接住。
  // 逐个绑会随表单重绘一起被丢掉，和统计页天数切换是同一个坑
  form.addEventListener('click', (e) => {
    const c = e.target.closest('.seg-btn[data-wcat]');
    if (c) {
      wishCategory = categoryDef(c.dataset.wcat).name;
      $$('.seg-btn[data-wcat]').forEach((b) => b.classList.toggle('on', b.dataset.wcat === wishCategory));
      // 只清小类，**不清地点** —— 和订单表单同一条规矩（地点想跨类复用）
      const t = $('#w-type');
      if (t) t.value = '';
      // 名称的必填跟着大类走（餐饮必填 / 生鲜零食选填）
      applyWishMode();
      renderWishSuggAll();
      return;
    }
    const p = e.target.closest('.seg-btn[data-wpri]');
    if (p) {
      $$('.seg-btn[data-wpri]').forEach((b) => b.classList.toggle('on', b === p));
      return;
    }
    const chip = e.target.closest('[data-sug-for]');
    if (chip) applySugChip(chip);
  });

  // 地点 / 小类边打边筛（预置词条不参与筛选，见 renderSuggest 的注释）
  ['#w-city', '#w-type'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('input', renderWishSuggAll);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#w-name').value.trim();
    // 名称**完全选填**（v3.0.2 起，和订单表单的「店铺名称」同一条规矩）——
    // 只记得「楼下那家」也能先记下来，卡片上有兜底文案（见 wishCard）。
    const onPri = $('.seg-btn.on[data-wpri]');
    const w = {
      // 前缀 w：和订单 id 区分开，人打开导出文件时一眼能认出这是哪张表的
      id: 'w' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      storeName: name,
      city: $('#w-city').value.trim(),
      category: wishCategory,
      foodType: $('#w-type').value.trim(),
      want: $('#w-want').value.trim(),
      reason: $('#w-reason').value.trim(),
      priority: parseInt(onPri && onPri.dataset ? onPri.dataset.wpri : '', 10) || 2,
      createdAt: Date.now(),
    };
    try {
      await putWish(w);
    } catch (err) {
      // await 之后的成功提示必须先确认 await 真的成功了，
      // 否则写库失败时表单留着、没提示，看起来就是「点了没反应」
      toast('保存失败：' + (err && err.message ? err.message : '存储被占用，请重启应用后重试'));
      return;
    }
    wishes.push(w);
    resetWishForm();
    toggle(false);
    renderWishes();
    toast('已加入待点评');
  });

  // 卡片上的两个动作。委托在列表容器上 —— 卡片是整块重建的
  $('#wish-list').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { goReview(go.dataset.go); return; }
    const del = e.target.closest('[data-del]');
    if (del) deleteWishById(del.dataset.del, del);
  });

  // 搜索 / 排序
  $('#wq').addEventListener('input', () => { wishQ = $('#wq').value; renderWishes(); });
  $('#w-sort').addEventListener('change', () => { wishSort = $('#w-sort').value; renderWishes(); });
  // 「取消」只是不删那条待点评；订单表单里已经预填的值保持不动，
  // 用户想接着录完这单是完全合理的
  $('#wish-banner-cancel').addEventListener('click', () => { pendingWishId = null; showWishBanner(''); });
}

// ---------- 聚合 ----------
// 收缩平均的平滑常数：样本越少，越往全局均分拉。
// 取 5 是权衡结果：1 单的店会被拉走 5/6 的距离，20 单的店基本不动。
// （取 3 时实测「1 单 5 分」仍能压过「20 单 4.8 分」，惩罚太轻）
const RATING_C = 5;

/** 全局均分：加权评分要向它收缩。一条数据都没有时给个中性值，避免除零。 */
function globalMeanOf(orders) {
  const rated = orders.filter((o) => o.rating > 0);
  return rated.length ? rated.reduce((s, o) => s + o.rating, 0) / rated.length : 3;
}

/**
 * 一组订单的公共指标。**分组只决定「哪些订单是一组」，指标怎么算与分组维度无关** ——
 * 所以店铺组和小类组共用这一份，别在渲染时各算一遍（两处各算一次迟早会不一致）。
 *
 * 人均 = 总价合计 / 人数合计，**只算份数单**：重量单的「斤」不是人，混进来会算出
 * 一个既非人均也非每斤的四不像，而且重量单越多、数字越小，看起来像"越吃越便宜"。
 */
function groupStats(list, globalMean) {
  const sorted = list.slice().sort((a, b) => b.date - a.date);
  // 总价可能被手工改过的备份写成字符串或整段缺失：先转数再累加，
  // 否则 reduce 会退化成字符串拼接（'0'+'20'+'30' → '02030'）
  const sumTotal = sorted.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
  const parts = splitByUnit(sorted);
  const sumRating = sorted.reduce((s, o) => s + (o.rating || 0), 0);
  return {
    list: sorted,
    count: sorted.length,
    avgPrice: sumTotal / sorted.length,
    perCapita: parts.fen && parts.fen.sumQty > 0 ? parts.fen.sumTotal / parts.fen.sumQty : null,
    avgRating: sumRating / sorted.length,
    // 收缩平均（贝叶斯平均）：别让「只去过 1 单给 5 分」的店长期霸占评分榜首。
    // 1 单 5 分会向全局均分靠拢，20 单的店几乎不动。
    weightedRating: (sumRating + RATING_C * globalMean) / (sorted.length + RATING_C),
    // 分桶结果挂在这里，卡片渲染和排序都要用
    unitParts: parts,
    categories: [...new Set(sorted.map(catOf))],
    foodTypes: [...new Set(sorted.map((o) => o.foodType).filter(Boolean))],
    channels: [...new Set(sorted.map((o) => o.channel).filter(Boolean))],
    platforms: [...new Set(sorted.map((o) => o.platform).filter(Boolean))],
    dishImages: sorted.map((o) => o.dishImage).filter(Boolean),
  };
}

/**
 * 一家店一组。**只看店铺，不掺大类** —— 统计页的「点得最多的店 / 花钱最多的店」
 * 和几处回归测试都按这个口径要数据，所以它保持原样，别改成分组随大类走。
 * 列表页要的那种混合分组在 buildGroups。
 */
function groupByStore(orders) {
  const globalMean = globalMeanOf(orders);
  const map = new Map();
  for (const o of orders) {
    // 没店名的单归一个「未命名店铺」组，而不是每条各成一组 ——
    // 否则统计页的店铺排行会被一堆空名条目刷屏、店铺数也虚高。
    const k = orderKeyOf(o) || '未命名店铺';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(o);
  }
  return [...map.entries()].map(([key, list]) => {
    // 地点不再是身份的一部分，同一个键下可能横跨好几个城市 → 收成列表
    const cities = [...new Set(list.map((o) => o.city).filter(Boolean))];
    return Object.assign({ key, name: key, cities }, groupStats(list, globalMean));
  });
}

// ---------- 列表页的分组：餐饮按店铺，其他按小类 ----------
/**
 * 一条订单属于哪个组。
 *
 * v3.0 的分组规则：**餐饮按店铺、生鲜/零食按小类**。
 * 理由：买菜买零食时「从哪家店买的」几乎不重要（同一袋苹果可能来自盒马，
 * 也可能来自永辉），回头查账想看的轴是「买了什么」；而吃饭时一家店才是
 * 一个有意义的单位（口味、出餐、性价比都是冲着那家店去的）。
 *
 * 小类的组键带一个 'food:' 前缀，避免和 storeKey（店名|地点）撞上 ——
 * 虽然实际上不会撞，但一个「苹果|」的店名就能让它撞，加上前缀是零成本的保险。
 */
// FOOD_GROUP_PREFIX 在文件上方声明（storeMeta 那一段）—— 它同时是
// 列表页的分组键前缀和小类评价在 storeMeta 里的键前缀，两处必须是同一个值。
function groupOf(o) {
  // 餐饮按店铺。没店名的归「未命名店铺」组 —— 那个键不可能以 food: 开头，
  // 不会和小类组撞上（这也是它不用走 orderKeyOf 兜底也能安全的原因）。
  if (catOf(o) === CATEGORY.MEAL) return { kind: 'store', key: orderKeyOf(o) || '未命名店铺' };
  const ft = String(o.foodType == null ? '' : o.foodType).trim();
  return { kind: 'food', key: FOOD_GROUP_PREFIX + ft };
}

/** 列表页用的混合分组，返回的每一项都带 kind（'store' / 'food'）。 */
function buildGroups(orders) {
  const globalMean = globalMeanOf(orders);
  const map = new Map();
  for (const o of orders) {
    const g = groupOf(o);
    if (!map.has(g.key)) map.set(g.key, { kind: g.kind, list: [] });
    map.get(g.key).list.push(o);
  }
  return [...map.entries()].map(([key, g]) => {
    if (g.kind === 'store') {
      // 键就是店名（没店名的组键是「未命名店铺」）；地点只当副标题信息，
      // 不再是身份的一部分，所以可能有好几个
      const cities = [...new Set(g.list.map((o) => o.city).filter(Boolean))];
      return Object.assign({ key, kind: 'store', name: key, cities }, groupStats(g.list, globalMean));
    }
    // 小类没填的订单也要有个落点：单独归成「小类未填」一组，
    // 而不是塞进某个具体小类里张冠李戴
    const name = key.slice(FOOD_GROUP_PREFIX.length) || '小类未填';
    const storeSources = [...new Set(g.list.map(orderKeyOf).filter(Boolean))]
      .map((k) => ({ key: k, name: k }));
    return Object.assign({
      key, kind: 'food', name, storeSources,
      cities: [...new Set(g.list.map((o) => o.city).filter(Boolean))],
    }, groupStats(g.list, globalMean));
  });
}

/**
 * 店铺卡片的统计格。**份数和重量分两行**，不合并成一个「人均」——
 * 「人均 ¥20」和「每斤 ¥26.5」是两个不同单位的数，摆在一起比大小没有意义。
 *
 * 订单数 / 原始均分 / 均价三项与计量单位无关，放第一行（两桶合计）；
 * 第二行才是分开的口径：份数行给「人均」，重量行给「每斤」。只有一种模式时
 * 只渲染那一行 —— 摆一行全是 0 的另一种模式只会占地方。
 */
function storeStatsHtml(s) {
  const parts = splitByUnit(s.list);
  const rows = [];
  if (parts.fen) {
    rows.push(`<div class="stat-row">
      <span class="stat-tag fen">份数</span>
      <span class="stat-line">${parts.fen.count} 单 · 均价 ¥${parts.fen.avgPrice.toFixed(1)}` +
      (parts.fen.perUnit === null ? '' : ` · 人均 ¥${parts.fen.perUnit.toFixed(1)}`) + `</span>
    </div>`);
  }
  if (parts.jin) {
    rows.push(`<div class="stat-row">
      <span class="stat-tag jin">重量</span>
      <span class="stat-line">${parts.jin.count} 单 · 均价 ¥${parts.jin.avgPrice.toFixed(1)}` +
      (parts.jin.perUnit === null ? '' : ` · 每斤 ¥${parts.jin.perUnit.toFixed(1)}`) +
      (parts.jin.sumQty > 0 ? ` · 共 ${trimNum(parts.jin.sumQty)} 斤` : '') + `</span>
    </div>`);
  }
  return `<div class="stats">
    <div class="stat"><b>${s.count}</b>总单数</div>
    <div class="stat"><b>${s.avgRating.toFixed(1)}</b>原始均分</div>
  </div>
  <div class="stat-rows">${rows.join('')}</div>`;
}

/**
 * 统计页的「按大类分开统计」卡片。
 *
 * v2.7 起它**取代**了原来的「份数 / 重量分开统计」。理由：大类跟计量方式
 * 本来就几乎一一对应（餐饮=份数、生鲜零食=重量），两张卡摆出来的数字长得
 * 几乎一样；而大类选完之后单位还能手动改，两张卡必然会冒出一行对不上的数。
 * 与其让用户去猜哪张对，不如只留一张。
 *
 * 指标分两类：
 *   - 单数 / 合计 / 均价 / 占比 —— **与计量单位无关**，怎么切分类都成立
 *   - 人均 / 每斤 —— 只在**该大类里的单子单位一致**时才给。混着的时候硬算
 *     人均就是把斤数当头数（v2.6 踩过的坑），宁可不给，也不能给个错的。
 */
function categoryStatsCard(orders, totalCount, cat) {
  if (!orders.length) return '';
  // 选定了某个大类 → 换成对**它**做小类分解。
  // 不换的话这张卡只剩一行（另两个大类刚被过滤掉），白占一块地方；
  // 而「大类 → 小类」本来就是这套数据的两级，往下切一层是自然的下一步。
  if (cat) return subCategoryStatsCard(orders, cat, totalCount);
  const totalSum = orders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
  const rows = [];
  for (const c of CATEGORIES) {
    const list = orders.filter((o) => catOf(o) === c.name);
    if (!list.length) continue;   // 空的大类不占一行，摆一个 0 只会占地方
    const sum = list.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
    const parts = splitByUnit(list);
    let unitCell = '';
    if (!parts.fen || !parts.jin) {
      const p = parts.fen || parts.jin;
      if (p.perUnit !== null) {
        unitCell = `<span class="us-cell"><b>¥${p.perUnit.toFixed(1)}</b>` +
          `<small>${parts.fen ? '人均' : '每斤'}</small></span>` +
          `<span class="us-cell"><b>${trimNum(p.sumQty)}</b>` +
          `<small>${parts.fen ? '人数' : '斤数'}</small></span>`;
      }
    }
    rows.push(`<div class="us-row">
      <span class="stat-tag ${c.cls}">${c.name}</span>
      <span class="us-nums">
        <span class="us-cell"><b>${list.length}</b><small>单</small></span>
        <span class="us-cell"><b>¥${sum.toFixed(0)}</b><small>合计</small></span>
        <span class="us-cell"><b>¥${(sum / list.length).toFixed(1)}</b><small>均价</small></span>
        <span class="us-cell"><b>${totalSum > 0 ? Math.round((sum / totalSum) * 100) : 0}%</b><small>占比</small></span>
        ${unitCell}
      </span>
    </div>`);
  }
  if (!rows.length) return '';
  return `<div class="card">
    <div class="stat-head"><span>按大类分开统计</span><small>共 ${totalCount} 单</small></div>
    <div class="us-rows">${rows.join('')}</div>
    <p class="hint">占比按金额算；人均 / 每斤只在该大类单位一致时给出。</p>
  </div>`;
}

/**
 * 「某大类 · 按小类分开统计」。选中具体大类后接替上面那张卡。
 *
 * 行按单数从多到少排（那才是「我在这类上最常买什么」的答案），
 * 同数按名字排，免得每次渲染顺序抖动。没填小类的订单单独成一桶 ——
 * 摊到别的行上是张冠李戴。指标口径与上面那张卡完全一致，
 * 人均 / 每斤同样只在单位一致时给。
 */
function subCategoryStatsCard(orders, cat, totalCount) {
  const map = new Map();
  for (const o of orders) {
    const ft = String(o.foodType == null ? '' : o.foodType).trim() || '小类未填';
    if (!map.has(ft)) map.set(ft, []);
    map.get(ft).push(o);
  }
  const rows = [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh'));
  const totalSum = orders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
  return `<div class="card">
    <div class="stat-head"><span>${esc(cat)} · 按小类分开统计</span><small>共 ${totalCount} 单</small></div>
    <div class="us-rows">${rows.map(([name, list]) => {
      const sum = list.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
      const parts = splitByUnit(list);
      let unitCell = '';
      if (!parts.fen || !parts.jin) {
        const p = parts.fen || parts.jin;
        if (p.perUnit !== null) {
          unitCell = `<span class="us-cell"><b>¥${p.perUnit.toFixed(1)}</b>` +
            `<small>${parts.fen ? '人均' : '每斤'}</small></span>` +
            `<span class="us-cell"><b>${trimNum(p.sumQty)}</b>` +
            `<small>${parts.fen ? '人数' : '斤数'}</small></span>`;
        }
      }
      return `<div class="us-row">
        <span class="stat-tag ${catCls(cat)}">${esc(name)}</span>
        <span class="us-nums">
          <span class="us-cell"><b>${list.length}</b><small>单</small></span>
          <span class="us-cell"><b>¥${sum.toFixed(0)}</b><small>合计</small></span>
          <span class="us-cell"><b>¥${(sum / list.length).toFixed(1)}</b><small>均价</small></span>
          <span class="us-cell"><b>${totalSum > 0 ? Math.round((sum / totalSum) * 100) : 0}%</b><small>占比</small></span>
          ${unitCell}
        </span>
      </div>`;
    }).join('')}</div>
    <p class="hint">占比按金额算；人均 / 每斤只在单位一致时给出。切回「全部」看三个大类的横向对比。</p>
  </div>`;
}

/**
 * 一条订单的明细块。`meta` 由调用方拼好传进来 —— 店铺卡片和小类卡片的元信息
 * 行不一样（小类卡片必须带上店名），共用一份模板、元信息各自组装。
 */
function reviewItemHtml(o, meta) {
  return `
    <div class="review-item">
      <div class="review-meta">${meta}</div>
      <div class="review-text">${esc(o.items ? '实物：' + o.items + '\n' : '')}${esc(o.review || '（无评价）')}</div>
      ${o.dishImage ? `<img class="review-img zoomable" src="${o.dishImage}" alt="实物图片">` : ''}
      <div class="review-actions">
        <button type="button" data-edit="${esc(o.id)}">编辑</button>
        <button type="button" data-del="${esc(o.id)}">删除</button>
      </div>
    </div>`;
}

/**
 * 一组同款：组头摘要（笔数 / 合计 / 均价 / 日期跨度 / 平均分 / 合并评语）
 * 套着组内各条的**原始**明细。
 *
 * ⚠️ 这里**只是套了一层壳** —— 组内每条还是它自己那份数据（自己的日期、金额、
 * 评分、评语、图片），钱和统计各算各的。归组是渲染时按 dupKeyOf() 现算出来的，
 * 库里一条记录都没动过，所以既不需要「合并」动作，也没有什么需要「撤销」。
 */
function dupBlockHtml(members, metaOf) {
  const head = dupGroupHead(members);
  const shortDate = (ts) => {
    const d = new Date(ts);
    return String(d.getMonth() + 1).padStart(2, '0') + '/' +
           String(d.getDate()).padStart(2, '0');
  };
  // 跨天时给「首次 ~ 最近」，全都落在同一天就只写一个日期
  const span = head.first
    ? (dayKey(head.first) === dayKey(head.last)
        ? shortDate(head.first)
        : shortDate(head.first) + ' ~ ' + shortDate(head.last))
    : '日期未填';
  const score = head.rating > 0
    ? ` · 平均 <span class="stars">${stars(head.rating)}</span> <b>${trimNum(head.rating)}</b>`
    : '';
  const note = head.review
    ? `<div class="dup-block-note">${esc(head.review)}</div>` : '';
  return `
    <div class="dup-block">
      <div class="dup-block-head">
        <span class="dup-block-title">同款 ${head.count} 笔</span>
        <span class="dup-block-stat">共 ¥${trimNum(head.sum)} · 均价 ¥${(head.sum / head.count).toFixed(1)}</span>
      </div>
      <div class="dup-block-sub">${esc(span)}${score}</div>
      ${note}
      <div class="dup-block-rows">${members.map((o) => reviewItemHtml(o, metaOf(o))).join('')}</div>
    </div>`;
}

/**
 * 一张卡片里的订单明细。**同款的几条自动折成一块**放在第一次出现的位置上，
 * 其余照旧平铺 —— 归组是渲染时按 dupKeyOf() 现算的，库里没有任何标记，
 * 所以「自动」这件事没有开关，也不会留下需要清理的状态。
 *
 * 筛选 / 搜索会把同款里的一部分挡在外面：**只剩一条时不再套组头**（摆一个
 * 「同款 1 笔」的组出来只会让人以为数据坏了），那一条按普通明细渲染。
 */
function reviewListHtml(list, metaOf) {
  const buckets = new Map();
  for (const o of list) {
    const k = dupKeyOf(o);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(o);
  }
  const done = new Set();
  const out = [];
  for (const o of list) {
    const k = dupKeyOf(o);
    if (done.has(k)) continue;
    done.add(k);
    const members = buckets.get(k);
    out.push(members.length > 1
      ? dupBlockHtml(members, metaOf)
      : reviewItemHtml(o, metaOf(o)));
  }
  return out.join('');
}

function storeCard(s) {
  // 明细整块交给 reviewListHtml：同款的几条会自动折成一块（跨天也算同款），
  // 组内每条仍然是它自己那条，日期和金额一条不少。
  const reviews = reviewListHtml(s.list, (o) =>
    `${esc(new Date(o.date).toLocaleDateString())} · ${esc(o.platform || '平台未填')} · ` +
    `${esc(o.foodType || '小类未填')} · ¥${o.totalPrice}（${qtyText(o)}，${unitPriceText(o)}）· ` +
    `<span class="stars">${stars(o.rating || 0)}</span>`);
  // 地点已改为选填，空的时候别把分隔点也留出来（否则像「· 快餐 · 仅外卖」）。
  // 地点不再是店铺身份的一部分，同一张卡可能横跨多个城市 → 全部列出
  const sub = [
    (s.cities || []).map(esc).join('/'),
    s.foodTypes.map(esc).join('、') || '小类未填',
    s.channels.map(esc).join('/') || '消费方式未填',
  ].filter(Boolean).join(' · ');
  // 全部图片都渲染，横向滑动条承接数量 —— 原来只渲染前 4 张，
  // 第 5 张往后直接丢掉，用户完全不知道还有图。
  const imgs = s.dishImages;
  return `
    <div class="store" data-key="${esc(s.key)}">
      <div class="store-head">
        <div>
          <div class="store-name">${esc(s.name)}</div>
          <div class="store-sub">${sub}</div>
        </div>
        <div class="score">
          <b>${s.weightedRating.toFixed(1)}</b>
          <span class="stars">${stars(Math.round(s.weightedRating))}</span>
          <small>加权评分</small>
        </div>
      </div>
      ${storeStatsHtml(s)}
      ${imgs.length ? `<div class="dish-strip">${imgs.map((src) => `<img class="zoomable" src="${src}" alt="实物">`).join('')}</div>` : ''}
      ${imgs.length > 4 ? `<p class="dish-hint">共 ${imgs.length} 张，左右滑动查看</p>` : ''}
      ${storeNoteHtml(s)}
      <div class="store-actions">
        <button class="toggle" type="button">${openReviewKeys.has(s.key) ? '收起评价 ▴' : `查看 ${s.count} 条订单评价 ▾`}</button>
        <button class="store-del" type="button" data-delstore="${esc(s.key)}">删除整店</button>
      </div>
      <div class="reviews${openReviewKeys.has(s.key) ? ' open' : ''}">${reviews}</div>
    </div>`;
}

/**
 * 小类卡片：一张卡 = 一个「小类」，下面可能横跨好几家店。
 *
 * 和店铺卡片刻意长得很像（同一套 .store / .store-head / .store-stats 类名），
 * 因为两者在列表里是**平级混排**的，长得不一样会让人以为是两块不同的功能。
 * 差别只在三处：
 *   ① 卡片头是「小类」而不是店名，副标题给的是 大类 · 来源店铺 · 地点
 *   ② 每笔订单的元信息行必须带上店名 —— 卡片本身不含店名，不带就查不到是在哪买的
 *   ③ 底部是「删除整组」：整组订单一起删（组不是实体，**它的评价不跟着删**）
 *      而店铺级的东西（整体评价、支持清单）按**来源店铺**分开显示和维护
 *   ④ 卡片上同时挂着两层评价：**小类评价**（key 就是 g.key）和每个来源店铺的
 *      整体评价 —— 前者是全局共享的一段，后者按店分开，样式上分了层
 */
function foodCard(g) {
  // 明细同样走 reviewListHtml：小类卡片里的重复单也会被折成一块
  const reviews = reviewListHtml(g.list, (o) =>
    `${esc(new Date(o.date).toLocaleDateString())} · ${esc(o.storeName || '店名未填')} · ` +
    `${esc(o.platform || '平台未填')} · ¥${o.totalPrice}（${qtyText(o)}，${unitPriceText(o)}）· ` +
    `<span class="stars">${stars(o.rating || 0)}</span>`);
  const sub = [
    g.categories.map(esc).join('/'),
    g.storeSources.map((st) => esc(st.name)).join('、') || '店铺未填',
    g.cities.map(esc).join('/'),
  ].filter(Boolean).join(' · ');
  const imgs = g.dishImages;
  return `
    <div class="store food-group" data-key="${esc(g.key)}">
      <div class="store-head">
        <div>
          <div class="store-name">${esc(g.name)}</div>
          <div class="store-sub">${sub}</div>
        </div>
        <div class="score">
          <b>${g.weightedRating.toFixed(1)}</b>
          <span class="stars">${stars(Math.round(g.weightedRating))}</span>
          <small>加权评分</small>
        </div>
      </div>
      ${storeStatsHtml(g)}
      ${imgs.length ? `<div class="dish-strip">${imgs.map((src) => `<img class="zoomable" src="${src}" alt="实物">`).join('')}</div>` : ''}
      ${imgs.length > 4 ? `<p class="dish-hint">共 ${imgs.length} 张，左右滑动查看</p>` : ''}
      <div class="group-notes">${storeNoteHtml({ key: g.key }, '', 'food')}${g.storeSources.map((st) => storeNoteHtml(st, st.name)).join('')}</div>
      <div class="store-actions">
        <button class="toggle" type="button">${openReviewKeys.has(g.key) ? '收起订单 ▴' : `查看 ${g.count} 笔订单 ▾`}</button>
        <button class="store-del" type="button" data-delgroup="${esc(g.key)}">删除整组</button>
      </div>
      <div class="reviews${openReviewKeys.has(g.key) ? ' open' : ''}">${reviews}</div>
    </div>`;
}

/** 列表页的一张卡：按分组类型分发。两种卡片共用布局类名，只是内容不同。 */
function groupCard(g) {
  return g.kind === 'food' ? foodCard(g) : storeCard(g);
}

// ---------- 店铺整体评价（渲染 + 内联编辑） ----------
let editingNoteKey = null;   // 正在编辑哪一家
/**
 * 哪些店铺的「N 条订单评价」是展开的。
 * 展开状态必须存在外面：保存店铺评价、改排序、搜索都会整块重绘列表，
 * 不记着的话用户刚点开的评价列表会被当场收回去 —— 而他只是想写条备注。
 */
let openReviewKeys = new Set();
/**
 * storeKey -> 输入中的文字。
 * 列表会因为搜索 / 排序 / 筛选 / 保存订单被整块 innerHTML 重建，
 * 编辑中的 textarea 会连同节点一起消失 —— 不在外面存一份，
 * 用户打到一半去点一下搜索框，写的东西就没了。
 */
let noteDraft = {};

function noteTextOf(key) {
  if (Object.prototype.hasOwnProperty.call(noteDraft, key)) return noteDraft[key];
  const m = storeMeta[key];
  return (m && m.note) || '';
}

/**
 * 评价那块 UI。**店铺整体评价和小类评价共用这一份**，只有文案不同。
 *
 * `ownerLabel` 只在小类卡片里用：一张小类卡片下可能挂着好几家店的整体评价，
 * 不点名根本分不清哪段是谁的。店铺卡片不传 —— 卡片头就是店名，重复一遍是噪音。
 *
 * `kind='food'` 表示这是**小类评价**（key 是 'food:小类名'）：文案和 placeholder
 * 都换一套 —— 在「苹果」底下写「这家店的口味、分量」很荒谬。
 * 注意「小类评价」和「某个来源店铺的整体评价」会同时出现在一张小类卡片上，
 * 所以两者的样式必须能一眼分出层次（见 style.css 的 .store-note.food）。
 */
function storeNoteHtml(s, ownerLabel, kind) {
  const key = esc(s.key);
  const food = kind === 'food';
  const label = food ? '小类评价'
    : (ownerLabel ? `${esc(ownerLabel)} 整体评价` : '店铺整体评价');
  // 类名写成「字面量 + 可选修饰」，不要整段放进 ${} 里 —— check_refs.py 会把
  // ${...} 整块剥掉再查 class，套在里面等于这个类名不受那道检查保护
  const ph = food
    ? '这个小类的整体印象：品质、价格、值不值得再买……'
    : '这家店的整体印象：口味、分量、出餐速度、卫生、性价比……';
  if (editingNoteKey === s.key) {
    return `
      <div class="store-note${food ? ' food' : ''}">
        <div class="store-note-head"><span class="store-note-label">${label}</span></div>
        <textarea class="store-note-input" data-noteinput="${key}" rows="3"
          placeholder="${ph}">${esc(noteTextOf(s.key))}</textarea>
        <div class="store-note-actions">
          <button type="button" class="ghost" data-notecancel="${key}">取消</button>
          <button type="button" class="primary" data-notesave="${key}">保存</button>
        </div>
      </div>`;
  }
  const text = noteTextOf(s.key);
  if (!text) {
    const add = food ? '＋ 写小类评价'
      : (ownerLabel ? `＋ 写「${esc(ownerLabel)}」的整体评价` : '＋ 写店铺整体评价');
    return `<button type="button" class="store-note-add${food ? ' food' : ''}" data-noteedit="${key}">${add}</button>`;
  }
  return `
    <div class="store-note${food ? ' food' : ''}">
      <div class="store-note-head">
        <span class="store-note-label">${label}</span>
        <button type="button" class="store-note-edit" data-noteedit="${key}">编辑</button>
      </div>
      <div class="store-note-text">${esc(text)}</div>
    </div>`;
}

// 重绘之后 textarea 是**新节点**，必须重新聚焦并把光标挪到末尾，
// 否则点「编辑」后键盘不弹，看起来像点了没反应。
function focusNoteInput(key) {
  const el = $$('.store-note-input').filter((n) => n.getAttribute('data-noteinput') === key)[0];
  if (!el) return;
  try { el.focus(); } catch (e) { /* 某些实现不支持 focus，忽略 */ }
  try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* 同上 */ }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
}

async function saveStoreNote(btn, key) {
  const text = noteTextOf(key).trim();
  // 小类卡片上的评价块也走这一条路（key = 'food:小类名'），只有提示文案不同
  const food = isFoodMetaKey(key);
  btn.disabled = true;
  try {
    // 合并写统一收在 writeNoteRow 里 —— 这里只管按钮状态和重绘。
    // kind 显式传下去：归属靠行上的字段判，不靠键前缀（见 kindOfRow）
    await writeNoteRow(key, text, food ? 'food' : 'store');
  } catch (err) {
    // 失败不能让按钮永久卡在禁用态
    btn.disabled = false;
    toast('保存失败：' + (err && err.message ? err.message : '存储被占用，请重启应用后重试'));
    return;
  }
  delete noteDraft[key];
  editingNoteKey = null;
  renderStores(_lastOrders);
  const what = food ? '小类评价' : '店铺评价';
  toast(text ? what + '已保存' : what + '已清除');
}

// ---------- 排序 ----------
// 每家店的可排序指标；get 返回用于比较的数值
const SORT_DEFS = {
  // 按评分 = 按加权评分（收缩平均），不是原始均分。
  // 这样「只去过 1 单给 5 分」的店不会长期压在常去的店上面。
  rating:    { get: (s) => s.weightedRating },
  avgPrice:  { get: (s) => s.avgPrice },
  // 「按人均/每斤」= 每家店的单位价。份数店用人均、重量店用每斤 ——
  // 两个都是「单位量的价格」，放在同一列里比大小至少是同一个口径。
  // 只有重量单的店没有「人均」，此时退回它的每斤均价，别让它掉到 0 排最后。
  perCapita: { get: (s) => (s.perCapita !== null ? s.perCapita : (s.unitParts.jin ? s.unitParts.jin.perUnit : 0)) },
  count:     { get: (s) => s.count },
  recent:    { get: (s) => (s.list[0] ? s.list[0].date : 0) }, // list 已在聚合时按时间倒序
};
const SORT_LS = 'waimai_sort';
let sortState = { key: 'rating', dir: 'desc' };
try {
  const saved = JSON.parse(localStorage.getItem(SORT_LS) || 'null');
  if (saved && SORT_DEFS[saved.key]) {
    sortState = { key: saved.key, dir: saved.dir === 'asc' ? 'asc' : 'desc' };
  }
} catch (e) { /* 存储被禁用时用默认值 */ }

function saveSort() {
  try { localStorage.setItem(SORT_LS, JSON.stringify(sortState)); } catch (e) { /* 忽略 */ }
}

function sortStores(stores) {
  const get = SORT_DEFS[sortState.key].get;
  const sign = sortState.dir === 'asc' ? 1 : -1;
  return stores.slice().sort((a, b) => {
    const d = (get(a) - get(b)) * sign;
    // 指标相同时按店名排，避免每次渲染顺序抖动
    return d !== 0 ? d : a.name.localeCompare(b.name, 'zh');
  });
}

function updateSortUI() {
  $('#sort-key').value = sortState.key;
  const b = $('#sort-dir');
  b.textContent = sortState.dir === 'desc' ? '↓ 降序' : '↑ 升序';
  b.dataset.dir = sortState.dir;
}

/**
 * 订单页顶部的汇总条：合计 / 单数 / 家店 / 均价。
 *
 * 口径**必须和下面卡片上写的一致**，所以直接对分组结果求和
 * （卡片上显示的「总单数」就是 g.count），不另算一遍 —— 两份口径迟早会漂，
 * 而两处数字对不上时用户只会认为是 bug。
 */
function updateSumBar(groups) {
  const cEl = $('#sum-count');
  if (!cEl) return;                 // 老 HTML 里没这一行时静默跳过，别把整页拖崩
  let n = 0, total = 0;
  const stores = new Set();
  for (const g of groups) {
    n += g.count;
    for (const o of g.list) {
      total += Number(o.totalPrice) || 0;   // 手工改过的备份可能把价格写成字符串
      const k = orderKeyOf(o);
      if (k) stores.add(k);                 // 没店名的单不算一家「店」，与统计页同口径
    }
  }
  cEl.textContent = n;
  $('#sum-total').textContent = '¥' + total.toFixed(0);
  $('#sum-store').textContent = stores.size;
  $('#sum-avg').textContent = '¥' + (n ? (total / n).toFixed(1) : '0');
}

/**
 * 「已选条件」那一行。
 *
 * 它是筛选状态**唯一常驻可见的出口**：面板一收起来，就只剩它说明列表为什么变少。
 * 大类刻意**不列在里面** —— 顶上那条快捷条已经常驻显示着它了，再来一个标签是重复。
 * 每一条都能点掉（委托见 bindEvents）。
 */
const FILTER_DIMS = [
  ['#f-month', '月份'], ['#f-store', '店铺'], ['#f-city', '地点'],
  ['#f-platform', '平台'], ['#f-food', '小类'], ['#f-channel', '实际消费方式'],
];

function renderFilterChips() {
  const box = $('#filter-chips');
  if (!box) return;
  const chips = [];
  for (const [sel, label] of FILTER_DIMS) {
    const el = $(sel);
    if (!el || !el.value) continue;
    // 显示 option 的文字而不是 value —— 月份存的是 '2026-09'，直接摆出来看不懂
    const o = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    chips.push(`<button type="button" class="chip" data-chip="${sel}">` +
      `${esc(label)}：${esc(o ? o.textContent : el.value)}<i>✕</i></button>`);
  }
  const min = $('#f-min').value, max = $('#f-max').value;
  if (min !== '' || max !== '') {
    chips.push(`<button type="button" class="chip" data-chip="#f-price">` +
      `均价 ¥${esc(min || '0')}–${esc(max || '不限')}<i>✕</i></button>`);
  }
  // 末尾补一枚「清除全部」：**chips 非空才加** —— 一条都没有时不摆这个按钮。
  // 它和面板里的「重置筛选」、工具条上的「清除筛选」走同一个出口 resetFilters()。
  if (chips.length) {
    chips.push('<button type="button" class="chip chip-clear" data-chip="#f-all">清除全部<i>✕</i></button>');
  }
  box.hidden = !chips.length;
  box.innerHTML = chips.join('');
}

/**
 * 大类快捷条的高亮跟着 #f-cat 走。
 * 快捷条**不改筛选逻辑**，只是 #f-cat 的另一个入口 —— 过滤永远只有
 * filterStores 一个出口，两个入口都只负责改它的 value。
 */
function syncCatSeg() {
  const seg = $('#cat-seg');
  const sel = $('#f-cat');
  if (!seg || !sel) return;
  $$('#cat-seg .seg-btn').forEach((b) =>
    b.classList.toggle('on', (b.getAttribute('data-cat') || '') === sel.value));
}

function renderStores(orders) {
  const box = $('#store-list');
  if (!orders.length) {
    updateSumBar([]);
    renderFacetCounts([]);   // 一条数据都没有时把候选上的数字清成 0，别留着上一次的
    renderFilterChips();
    renderFilterBar();
    syncCatSeg();
    box.innerHTML = '<div class="empty">还没有订单，去「添加」上传第一单吧</div>';
    return;
  }
  const groups = sortStores(filterStores(orders));
  // 汇总、候选单数、已选条件、控件排状态、快捷条高亮五处都从这一份结果推出来。
  // 统一挂在 renderStores 里，是因为它是**唯一碰列表的出口** ——
  // 分散到各个 change 监听里迟早会漏掉一个（比如导入备份后那条路径）。
  updateSumBar(groups);
  renderFacetCounts(orders);   // 传**全量**：候选数字要自己叠加筛选，不能用筛后的结果
  renderFilterChips();
  renderFilterBar();
  syncCatSeg();
  if (!groups.length) {
    const q = ($('#q').value || '').trim();
    box.innerHTML = `<div class="empty">没有${q ? `匹配「${esc(q)}」的` : '符合筛选条件的'}记录</div>`;
    return;
  }
  box.innerHTML = groups.map(groupCard).join('');
}

// 最近一次全量订单，供编辑时按 id 查找
let _lastOrders = [];

// ---------- 同款订单：自动归组 ----------
/**
 * 判定「两条订单点的是不是同一款」的字段表。**同款 = 这 9 项全一致。**
 *
 * **刻意排除 rating / review** —— 它们正是要在组头合并展示的两项。把评分也算进
 * 判定，两条记录就必须连分数都一模一样才叫同一款，而那样「组的平均分」永远等于
 * 原值，整个展示就没有意义了。
 *
 * **也排除 totalPrice / id / date / dishImage / storeKey**：
 *   - **totalPrice 不参与**：同款的价格本来就会变（涨价、换平台满减不同），
 *     而组头要展示的恰恰是「每次分别花了多少」—— 拿它判定等于要求每次价格一样，
 *     那样「看每次的总价」就无从谈起；
 *   - id 是主键，天然不同；
 *   - **date 不参与**（v3.2.0 起）：这一条是整个功能的立身之本 —— 同款**跨天**
 *     也要归到一起，才能看到「这款我点了几次、每次什么时候、每次多少钱」。
 *     日期一旦进判定，就只有同一天的两条会归到一起，等于看不到任何历史。
 *   - dishImage 是附加物，各留各的，拿它判定等于要求「两张照片也得一样」；
 *   - storeKey 由 storeName 派生，比了是重复劳动。
 *
 * 其余 9 项业务字段全部参与，**包括 items / channel / people**：同一家店点两样
 * 不同的东西、一次 1 人一次 3 人，都是真的两款，不该归到一起。
 */
const DUP_FIELDS = ['storeName', 'city', 'platform', 'category', 'foodType',
                    'channel', 'items', 'people', 'unit'];

/** 一条订单的「同款键」。9 项业务字段全一致 → 同一个键，渲染时归到一起。 */
function dupKeyOf(o) {
  const parts = DUP_FIELDS.map((f) => {
    // 大类 / 计量方式走各自的归一函数：老订单没有 category / unit 字段，
    // 直接读原字段会让「同一条老单导入两次」看起来像两款不同的东西
    if (f === 'category') return catOf(o);
    if (f === 'unit') return isJin(o) ? UNIT.WEIGHT : UNIT.PIECES;
    // 数量按数值比：'2' 和 2.0 是同一款
    if (f === 'people') return trimNum(Number(o[f]) || 0);
    return String(o[f] == null ? '' : o[f]).trim();
  });
  // 用 U+0001 当分隔符：用户填的任何文本里都不可能出现它，否则
  // 「A|B 店 + C 菜」和「A 店 + B|C 菜」会拼出同一个键
  return parts.join('\u0001');
}

/**
 * 算出一组同款的**组头摘要**：笔数、金额、日期跨度、合并评语、平均分。
 * **纯函数**，不碰库也不碰 DOM —— 组头就靠它。
 *
 * **它只产出摘要，不改任何一条订单**：组内每条仍然带着自己的日期 / 金额 /
 * 评分 / 评语 / 图片，钱和统计各算各的。所谓「归到一起」只是渲染时把它们
 * 摆进同一个块里 —— 一条数据都没动过，所以不需要撤销、也不需要快照。
 *
 *   - count / sum / avg：笔数、各条价格之和、均价（价格本来就各是各的）；
 *   - first / last：组内最早和最晚的购买日期，「07/12 ~ 09/28」就是它俩；
 *   - 评语：按顺序用「；」拼起来，空的和重复的丢掉（同一款可能几次都写了话）；
 *   - 评分：只算打过分（>0）的，取算术平均，留一位小数；一条都没打就返回 0。
 */
function dupGroupHead(list) {
  const notes = [];
  const stamps = [];
  let sum = 0;
  for (const o of list) {
    const t = String(o.review == null ? '' : o.review).trim();
    if (t && notes.indexOf(t) === -1) notes.push(t);
    sum += Number(o.totalPrice) || 0;
    const ts = Number(o.date);
    if (isFinite(ts) && ts > 0) stamps.push(ts);
  }
  stamps.sort((a, b) => a - b);
  const rated = list.filter((o) => Number(o.rating) > 0);
  const rating = rated.length
    ? Math.round((rated.reduce((s, o) => s + Number(o.rating), 0) / rated.length) * 10) / 10
    : 0;
  return {
    count: list.length,
    sum,
    avg: list.length ? sum / list.length : 0,
    first: stamps.length ? stamps[0] : 0,
    last: stamps.length ? stamps[stamps.length - 1] : 0,
    rating,
    review: notes.join('；'),
  };
}

// 列表点击委托：展开/收起、编辑、删除（只绑一次，避免重复监听）
function onStoreListClick(e) {
  // 图片看大图：放最前面，避免被后面的分支先吃掉。
  // 传整组而不是单张 —— lightbox 现在是图集，可以左右翻页
  const img = e.target.closest('.zoomable');
  if (img) { openLightbox(img.getAttribute('src'), collectGallery(img)); return; }

  // ---- 店铺整体评价：写 / 编辑 / 取消 / 保存 ----
  const noteEdit = e.target.closest('[data-noteedit]');
  if (noteEdit) {
    editingNoteKey = noteEdit.getAttribute('data-noteedit');
    renderStores(_lastOrders);
    focusNoteInput(editingNoteKey);
    return;
  }
  const noteCancel = e.target.closest('[data-notecancel]');
  if (noteCancel) {
    const key = noteCancel.getAttribute('data-notecancel');
    delete noteDraft[key];      // 丢弃未保存的输入
    editingNoteKey = null;
    renderStores(_lastOrders);
    return;
  }
  const noteSave = e.target.closest('[data-notesave]');
  if (noteSave) {
    saveStoreNote(noteSave, noteSave.getAttribute('data-notesave'));
    return;
  }

  const toggle = e.target.closest('.toggle');
  if (toggle) {
    // 不能再用 nextElementSibling：.toggle 现已包在 .store-actions 里，
    // 它的下一个兄弟是删除按钮，不是 .reviews
    const card = toggle.closest('.store');
    const r = card.querySelector('.reviews');
    const open = r.classList.toggle('open');
    // 同时记到 openReviewKeys：列表重绘后要能恢复展开状态
    const skey = card.getAttribute('data-key');
    if (open) openReviewKeys.add(skey); else openReviewKeys.delete(skey);
    // 两种卡片的文案不同：店铺卡展开的是一组订单评价，小类卡展开的是这组的若干笔订单
    const n = r.querySelectorAll('.review-item').length;
    const isFood = card.classList.contains('food-group');
    toggle.textContent = open
      ? (isFood ? '收起订单 ▴' : '收起评价 ▴')
      : (isFood ? `查看 ${n} 笔订单 ▾` : `查看 ${n} 条订单评价 ▾`);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = del.getAttribute('data-del');
    armConfirm(del, {
      hint: '再点一次确认删除',
      ask: '确认删除？',
      busy: '删除中…',
      done: '已删除',
      run: () => deleteOrder(id),
    });
    return;
  }
  const delStore = e.target.closest('[data-delstore]');
  if (delStore) {
    const key = delStore.getAttribute('data-delstore');
    armConfirm(delStore, {
      hint: '再点一次确认删除整店',
      ask: '确认删除整店？',
      busy: '删除中…',
      done: '整店已删除',
      // 订单和店铺评价在同一个事务里删掉，不会只剩半截
      run: () => deleteStoreAll(key, _lastOrders.filter((o) => (orderKeyOf(o) || '未命名店铺') === key).map((o) => o.id))
        .then(() => { delete storeMeta[key]; delete noteDraft[key]; openReviewKeys.delete(key); }),
    });
    return;
  }
  const delGroup = e.target.closest('[data-delgroup]');
  if (delGroup) {
    const key = delGroup.getAttribute('data-delgroup');
    // 组键带 'food:' 前缀，用同一套 groupOf 反查，别去猜 ID 的构成
    const ids = _lastOrders.filter((o) => groupOf(o).key === key).map((o) => o.id);
    armConfirm(delGroup, {
      hint: '再点一次确认删除整组',
      ask: '确认删除整组？',
      busy: '删除中…',
      done: '整组已删除',
      // 只删订单。**不能**顺手去删 storeMeta，两个理由：
      // ① 那几家店多半同时还有餐饮订单，它们的整体评价和支持清单不属于这一组；
      // ② 小类评价（key = 'food:小类名'）是**全局共享**的 —— 按小类名删掉它，
      //    别的店铺、生鲜零食两边的同名小类会跟着一起没。用户明确要求过
      //    「删整组不删评价」，所以这里就是纯粹的「只删订单」。
      // 代价是可能留下「已经没有订单再用这个 小类」的孤儿评价；它是可见、
      // 可再编辑的（下次录一条同名小类就能看到），比误删安全得多。
      run: () => deleteOrders(ids).then(() => { openReviewKeys.delete(key); }),
    });
    return;
  }
  const ed = e.target.closest('[data-edit]');
  if (ed) {
    const id = ed.getAttribute('data-edit');
    const o = _lastOrders.find((x) => x.id === id);
    if (o) {
      pendingEditOrder = o;
      writeForm(o);
      const sb = $('#submit-btn'); if (sb) sb.textContent = '保存修改';
      switchView('add');
      window.scrollTo(0, 0);
      toast('编辑中：保存后覆盖原记录');
    }
  }
}

// ---------- 筛选 ----------
/**
 * 建筛选下拉的候选。
 *
 * v3.0 起「店铺 / 地点 / 平台 / 大类 / 小类」是**平级**的五个维度
 * （外加月份和均价区间）—— 店铺不再天然是列表的顶层分组，生鲜/零食那半边
 * 是按小类分组、压根没有「店铺」这一层，所以它降级成一个普通筛选项。
 *
 * 候选一律从数据里现推（大类除外：它的取值是代码写死的三个，按数据推的话
 * 「这三个月没买过零食」会让用户以为零食这个类没了）。
 */
function fillFilterOptions(orders) {
  const uniq = (key) => [...new Set(orders.map((o) => o[key]).filter(Boolean))].sort();
  const pairs = [
    // 月份用 YYYY-MM 当 value —— 和 monthKey 同构，筛选时直接字符串比较即可
    ['#f-month', [...new Set(orders.map((o) => monthKey(o.date)))].sort().reverse()
      .map((m) => [m, monthLabel(m)])],
    ['#f-store', uniq('storeName').map((v) => [v, v])],
    ['#f-city', uniq('city').map((v) => [v, v])],
    ['#f-platform', uniq('platform').map((v) => [v, v])],
    // 大类**恒列三个**，不按数据过滤：顶上那条快捷条是常驻的四个按钮，
    // 两个入口必须能表达同一组取值 —— 只列有数据的话，点「零食」时
    // 赋值会被浏览器拒绝并回落成「全部」，表现成「点了没反应」。
    // （其余维度仍然现推：那些取值本来就是用户自己输入的，没有固定全集。）
    ['#f-cat', CATEGORIES.map((c) => [c.name, c.name])],
    ['#f-food', uniq('foodType').map((v) => [v, v])],
    ['#f-channel', uniq('channel').map((v) => [v, v])],
  ];
  for (const [sel, opts] of pairs) {
    const el = $(sel);
    if (!el) continue;  // 老版 HTML 里没有这一格时静默跳过，别把整页拖崩
    // 重建 option 会把选中值清空，**先存后还** —— 否则每次保存订单都会悄悄
    // 丢掉正在生效的那一项筛选。原来的值可能因为数据被删光而不复存在，
    // 这时赋值会被浏览器忽略并回落成「全部」，属可接受结果。
    const keep = el.value;
    el.innerHTML = '<option value="">全部</option>' +
      opts.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
    el.value = keep;
  }
}

/**
 * 按当前筛选条件过滤订单，再分组（渲染交给 renderStores）。
 *
 * **筛选在分组之前，而且是逐单判的**（v3.0 改了这一点）。原来城市/大类/小类
 * 是「这家店有没有这个属性」的整店判定；现在列表里混着小类卡片，
 * 一条订单到底落进哪个组、算不算命中，只有按单判才说得清 ——
 * 比如「店铺 = 盒马」时，一张横跨盒马和永辉的小类卡片不该把永辉那几笔
 * 也算进来，否则卡片上的单数/均价和用户选的筛选条件对不上。
 *
 * 均价区间和关键词仍在**组**上判：它们看的就是这一组的整体数字和全部文本。
 */
/**
 * 读一遍当前筛选条件。`override` 里出现的键**优先于 DOM**。
 *
 * 之所以能覆盖，是为了让「分面计数」复用同一个出口：给某个维度换一个候选值，
 * 其余条件原样保留，完整跑一遍过滤（含均价区间和关键词），数出来的单数就是
 * 「点下去真正会看到多少」。两个地方各读一遍 DOM 迟早会漂成两套判据。
 *
 * ⚠️ `k in o` 而不是真值判断：`{ cat: '' }` 这种「显式要求不限」也是合法覆盖，
 * 用 `o[k] || ...` 写会让空串被当成「没给」，永远回落到 DOM 里的当前值。
 */
function readFilters(override) {
  const o = override || {};
  const pick = (k, sel) => (k in o ? o[k] : $(sel).value);
  return {
    month: pick('month', '#f-month'),
    store: pick('store', '#f-store'),
    city: pick('city', '#f-city'),
    platform: pick('platform', '#f-platform'),
    cat: pick('cat', '#f-cat'),
    food: pick('food', '#f-food'),
    channel: pick('channel', '#f-channel'),
    min: parseFloat(pick('min', '#f-min')),
    max: parseFloat(pick('max', '#f-max')),
    q: String(pick('q', '#q') || '').trim().toLowerCase(),
  };
}

function filterStores(orders, override) {
  const f = readFilters(override);
  const scoped = orders.filter((o) =>
    (!f.month || monthKey(o.date) === f.month) &&
    (!f.store || o.storeName === f.store) &&
    (!f.city || o.city === f.city) &&
    (!f.platform || o.platform === f.platform) &&
    (!f.cat || catOf(o) === f.cat) &&
    (!f.food || o.foodType === f.food) &&
    (!f.channel || o.channel === f.channel));
  return buildGroups(scoped).filter((g) => {
    // 价格区间按**均价**比，不再按人均：均价 = 总额÷单数，与计量单位无关，
    // 份数单和重量单都能公平参与。用「人均」的话重量单的斤数会被当人数算，
    // 一个 ¥80/2.5斤 的单子会算出 ¥32 的假人均，区间筛选结果不可信。
    if (!isNaN(f.min) && g.avgPrice < f.min) return false;
    if (!isNaN(f.max) && g.avgPrice > f.max) return false;
    // 关键词：搜组名（店名或小类）/ 城市 / 平台 / 来源店铺 / 每次点了什么 / 评价正文。
    // 用「整组拼成一个大字符串再 includes」，任意一项命中就保留这一组。
    if (f.q) {
      const hay = [
        g.name, g.city || '',
        ...g.categories, ...g.foodTypes, ...g.platforms,
        ...(g.storeSources || []).map((s) => s.name),
        ...g.list.map((o) => o.storeName),
        ...g.list.map((o) => o.items),
        ...g.list.map((o) => o.review),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
}

/**
 * 「这一项选下去会有几单」。
 *
 * 口径 = **把这一维当成该候选值，重跑一遍完整过滤**（其余维度照旧、均价区间和
 * 关键词也在内），再把结果里的单数加起来。数字因此和「点进去真正看到的东西」
 * 出自同一次计算 —— 不会出现「候选上写着 5 单、点进去是 0 单」那种假数字。
 *
 * ⚠️ 每个候选要跑一次 filterStores。个人账本的候选规模（几十个以内）是毫秒级，
 * 别为它提前建缓存 —— 缓存和筛选状态不一致才是真正难查的麻烦。
 */
function facetCountFor(orders, key, val) {
  const ov = {};
  ov[key] = val;
  return filterStores(orders, ov).reduce((n, g) => n + g.count, 0);
}

/**
 * 把「选它有几单」填进大类快捷条和三个下拉的候选项里，跟着筛选**实时**变。
 *
 * 只做**店铺 / 大类 / 小类**这三个维度 —— 它们是「分组与筛选」的主轴，也是列表
 * 上真正成组的三样东西（餐饮按店铺成组、生鲜零食按小类成组，大类是分组的上层）。
 *
 * 漏掉自己那一维是关键：算「餐饮」的数字时当前的大类筛选被换掉，但**其余条件
 * （含搜索框、均价区间）全部生效**，所以数字始终是「现在点下去会看到多少」。
 *
 * ⚠️ **只在 renderStores 里调**。散到各个 change 监听里迟早会漏掉一条路径
 * （导入备份、删订单、清筛选），数字就停在旧值上 —— 「不实时」比「没有数字」更误导。
 */
function renderFacetCounts(orders) {
  const seg = $('#cat-seg');
  if (seg) {
    $$('#cat-seg .seg-btn').forEach((b) => {
      const num = b.querySelector('.seg-num');
      if (!num) return;                       // 老 HTML 没这个结构时静默跳过
      num.textContent = String(facetCountFor(orders, 'cat', b.getAttribute('data-cat') || ''));
    });
  }
  // 下拉的候选文字重写成「值（N 单）」。**只改 textContent、不动 option.value** ——
  // 改 value 会让当前选中的那一项当场失效（下拉弹出「全部」，列表却没变）。
  for (const [sel, key] of [['#f-store', 'store'], ['#f-cat', 'cat'], ['#f-food', 'food']]) {
    const el = $(sel);
    if (!el) continue;
    for (const opt of el.options) {
      // 「全部」不带数字：它是「不限」，挂个总数只会被读成「全部有 N 单」
      if (!opt.value) continue;
      opt.textContent = `${opt.value}（${facetCountFor(orders, key, opt.value)}）`;
    }
  }
}

/**
 * 当前生效的筛选条数。三个入口共用这一个口径（按钮徽标 / 「清除」按钮显隐 /
 * 已选条件是否为空），免得三处各算各的、迟早漂成两套。
 *
 * 口径：
 *   - FILTER_DIMS 里每个非空维度算 1。**月份已经在表里了**，别再单独加一次
 *     （早期写法就是逐个列字段，等价于此）；
 *   - 大类也要算 1 —— 它刻意不在 FILTER_DIMS 里（chips 不列它，快捷条已常驻），
 *     但它是真生效的一维，漏掉就会出现「点了快捷条却显示 0 项」；
 *   - 均价区间（min / max 任一非空）算 1。
 */
function filterCount() {
  let n = 0;
  for (const [sel] of FILTER_DIMS) {
    const el = $(sel);
    if (el && el.value) n++;
  }
  if ($('#f-cat').value) n++;
  if ($('#f-min').value !== '' || $('#f-max').value !== '') n++;
  return n;
}

// 兼容旧调用点（旧事件绑定 / 旧测试）：语义与 filterCount 完全一致。
function activeFilterCount() { return filterCount(); }

/**
 * 「更多筛选」那一层里生效了几项。和 filterCount 的区别**只在维度范围** ——
 * 这里只数被收进去的四样（地点 / 平台 / 实际消费方式 / 均价区间）。
 * 收起时用户看不到这几格，徽标就是唯一线索，所以它就是「收起也别忘了筛了什么」。
 */
function moreFilterCount() {
  let n = 0;
  for (const sel of ['#f-city', '#f-platform', '#f-channel']) {
    const el = $(sel);
    if (el && el.value) n++;
  }
  if ($('#f-min').value !== '' || $('#f-max').value !== '') n++;
  return n;
}

/**
 * 订单页顶部控件排的状态，统一在这里刷。三处：
 *   - #filter-n      生效条数（0 条时 hidden）
 *   - #filter-clear  一键清除（0 条时 hidden）—— 省一步「展开面板再点重置」
 *   - #more-toggle   低频层收起时的徽标（·N）—— 免得「列表变少却看不到条件」
 * 顺手把开合箭头（#filter-caret）和大类那排的按钮反色也一起刷了。
 *
 * ⚠️ 和 updateSumBar / renderFilterChips / renderFacetCounts 一样，**只在
 * renderStores 里调**。散到各个 change 监听里迟早会漏掉一条路径（导入备份、
 * 删订单、清筛选）。⚠️ 别用 textContent 整块覆盖 #filter-toggle ——
 * 它里面有 <b id="filter-n">，整体覆盖会把那个元素冲掉。
 */
function renderFilterBar() {
  const n = filterCount();
  const panel = $('#filter-panel');
  const open = panel ? !panel.hidden : false;

  const badge = $('#filter-n');
  if (badge) {
    badge.textContent = n ? ` · ${n}` : '';
    badge.hidden = n === 0;
  }
  const caret = $('#filter-caret');
  if (caret) caret.textContent = open ? ' ▴' : ' ▾';

  const toggle = $('#filter-toggle');
  if (toggle) toggle.classList.toggle('on', n > 0 || open);

  const clear = $('#filter-clear');
  if (clear) clear.hidden = n === 0;

  const more = $('#more-toggle');
  if (more) {
    const m = moreFilterCount();
    const mEl = $('#filter-more');
    const mOpen = mEl ? !mEl.hidden : false;
    more.textContent = '更多筛选' + (m ? ` ·${m}` : '') + (mOpen ? ' ▴' : ' ▾');
    more.classList.toggle('on', m > 0);
  }
}

// 兼容旧调用点（旧事件绑定 / 预览脚本）：语义与 renderFilterBar 完全一致。
function updateFilterToggle() { renderFilterBar(); }

/**
 * 一键清空**全部筛选条件**。三个入口共用它，别各写一份：
 *   - 面板里的「重置筛选」(#f-reset)
 *   - 工具条上的「清除筛选」(#filter-clear)
 *   - 已选条件里的「清除全部」chip(data-chip="#f-all")
 * 只清筛选维度，**不动搜索框 #q** —— 那是另一条线，自己有 #q-clear。
 * 本函数只改值、不碰列表，重绘交给调用方 renderStores()。
 */
function resetFilters() {
  ['#f-month', '#f-store', '#f-city', '#f-platform', '#f-cat',
   '#f-food', '#f-channel', '#f-min', '#f-max'].forEach((sel) => {
    const el = $(sel);
    if (el) el.value = '';
  });
}

// ---------- 统计 ----------
const monthKey = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};

// 按天的键。固定成 YYYY-MM-DD 是特意的：字典序 = 时间序，
// 做「最近 N 天」筛选时直接字符串比较即可，不用反复 new Date 比较。
const dayKey = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
};

// 'YYYY-MM' → '2026年9月'。同样只拆字符串构造，不走 new Date('2026-09')（UTC 解析会偏）。
function monthLabel(key) {
  const p = String(key).split('-').map(Number);
  return `${p[0]}年${p[1]}月`;
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 从 dayKey 反推「9/19 周五」。
// 不能直接 new Date('2026-09-19')：那是按 UTC 解析的，换到 UTC-x 时区会整体前移一天，
// 只能用拆分出来的年月日走本地时间构造。
function dayLabelFromKey(key) {
  const p = key.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return `${p[1]}/${p[2]} ${WEEK_CN[d.getDay()]}`;
}

// 横向条形组。max 自适应，宽度按比例，最小值 2% 保证「有值但很小」也看得见
function barRows(items, unit) {
  if (!items.length) return '<div class="empty small">暂无数据</div>';
  const max = Math.max(...items.map((i) => i.value), 1);
  return items.map((i) => `
    <div class="bar-row">
      <span class="bar-label">${esc(i.label)}</span>
      <span class="bar-track"><i style="width:${i.value > 0 ? Math.max(2, Math.round((i.value / max) * 100)) : 0}%"></i></span>
      <span class="bar-val">${unit === '¥' ? '¥' + i.value.toFixed(0) : i.value}</span>
    </div>`).join('');
}

// 店铺排行。名字比 barRows 的窄标签长得多，所以单独一套：
// 序号 + 店名（条形垫在名字下面）+ 右对齐的现成文本（「12 单」/「¥340」）。
function rankRows(items) {
  if (!items.length) return '<div class="empty small">暂无数据</div>';
  const max = Math.max(...items.map((i) => i.value), 1);
  return items.map((i, idx) => `
    <div class="rank-row">
      <span class="rank-no${idx < 3 ? ' top' : ''}">${idx + 1}</span>
      <span class="rank-main">
        <span class="rank-name">${esc(i.label)}</span>
        <span class="bar-track"><i style="width:${i.value > 0 ? Math.max(2, Math.round((i.value / max) * 100)) : 0}%"></i></span>
      </span>
      <span class="rank-val">${i.text}</span>
    </div>`).join('');
}

// 每日明细：一天一行，同时给出「几单」和「多少钱」。
// 只列有订单的天 —— 把空白天也铺出来会把列表拉到没法看，而且零值条本来就是噪音。
function dayRows(days) {
  if (!days.length) return '<div class="empty small">这段时间没有订单</div>';
  const max = Math.max(...days.map((d) => d.amount), 1);
  return days.map((d) => `
    <div class="day-row">
      <div class="day-top">
        <span class="day-label">${dayLabelFromKey(d.key)}</span>
        <span class="day-count">${d.count} 单</span>
        <span class="day-amt">¥${d.amount.toFixed(0)}</span>
      </div>
      <span class="bar-track"><i style="width:${Math.max(2, Math.round((d.amount / max) * 100))}%"></i></span>
    </div>`).join('');
}

// 按天聚合，返回按日期倒序的 [{key, count, amount}]
function groupByDay(orders) {
  const map = new Map();
  for (const o of orders) {
    const k = dayKey(o.date);
    const e = map.get(k) || { key: k, count: 0, amount: 0 };
    e.count += 1;
    e.amount += o.totalPrice;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

// ---------- 时间范围 ----------
// get(now) 返回 [起点, 终点) 毫秒时间戳；null 表示那一侧不限。
// 用半开区间 [from, to)：终点取「下个月 1 号 0 点」，「上月」才不会把本月第一天的订单也吃进来。
const RANGE_PRESETS = {
  all:   { label: '全部',  get: () => null },
  month: { label: '本月',  get: (n) => [new Date(n.getFullYear(), n.getMonth(), 1).getTime(), null] },
  prev:  { label: '上月',  get: (n) => [new Date(n.getFullYear(), n.getMonth() - 1, 1).getTime(),
                                        new Date(n.getFullYear(), n.getMonth(), 1).getTime()] },
  q3:    { label: '近3月', get: (n) => [new Date(n.getFullYear(), n.getMonth() - 2, 1).getTime(), null] },
  year:  { label: '今年',  get: (n) => [new Date(n.getFullYear(), 0, 1).getTime(), null] },
};
const STATS_RANGE_LS = 'waimai_stats_range';
// 统计页的大类口径（'' = 全部）。和「统计范围」是**两个平级的维度**，
// 一起决定整页看的是哪一撮单：范围管时间，大类管品类。
const STATS_CAT_LS = 'waimai_stats_cat';

/** 大类名 → 标色类名。和「按大类分开统计」卡上的小标签同源，别各写一份。 */
const catCls = (name) => (CATEGORIES.find((c) => c.name === name) || {}).cls || '';

function orderInRange(ts, win) {
  if (!win) return true;
  const [from, to] = win;
  if (from != null && ts < from) return false;
  if (to != null && ts >= to) return false;
  return true;
}

// 人类可读的范围描述，用来明确告诉用户"现在看的是哪一段"
function rangeLabel(key) {
  const p = RANGE_PRESETS[key];
  if (!p || key === 'all') return '全部数据';
  const [from, to] = p.get(new Date());
  const d = new Date(from);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${to == null ? '起' : ''}（${p.label}）`;
}

// 统计页当前统计的天数窗口（7 / 14 / 30），选择结果记住
const STATS_DAYS_LS = 'waimai_stats_days';
let statsDays = 14;
try {
  const v = parseInt(localStorage.getItem(STATS_DAYS_LS), 10);
  if (v === 7 || v === 14 || v === 30) statsDays = v;
} catch (e) { /* localStorage 不可用就用默认值，不影响统计 */ }

// 统计页当前的时间范围（RANGE_PRESETS 的键），同样记住
let statsRange = 'all';
try {
  const r = localStorage.getItem(STATS_RANGE_LS);
  if (r && RANGE_PRESETS[r]) statsRange = r;
} catch (e) { /* 同上 */ }

// 统计页当前的大类口径，同样记住。取值必须是 CATEGORIES 里真实存在的名字 ——
// 备份里改过的、或以后删掉的大类名会让整页锁死在一个空视图上。
let statsCat = '';
try {
  const c = localStorage.getItem(STATS_CAT_LS);
  if (c && CATEGORIES.some((x) => x.name === c)) statsCat = c;
} catch (e) { /* 同上 */ }

// 最近一次渲染用的订单。切换天数时靠它原地重绘，不必再读一遍数据库。
let _statOrders = [];

function renderStats(allOrders) {
  const box = $('#stats-body');
  _statOrders = allOrders;

  // 口径描述。时间和大类是**两个平级维度**，任何一处变化都要在标题和提示里
  // 同时说出来 —— 只写「全部数据」不写大类，用户会以为数字算错了。
  const scopeText = statsCat ? esc(statsCat) : '全部大类';

  // 范围选择器要无条件渲染。选中一段没有订单的时间后如果整页被空状态替掉，
  // 用户就再也切不回去了 —— 等于把自己锁死在一个空页面上。
  // 大类那排同理：切到没有数据的大类时必须还能切回来。
  const rangeCard = `
    <div class="card">
      <div class="stat-head"><span>统计范围</span><small>${esc(rangeLabel(statsRange))} · ${scopeText}</small></div>
      <div class="seg">
        ${Object.keys(RANGE_PRESETS).map((k) => `<button type="button" class="seg-btn${statsRange === k ? ' on' : ''}" data-stats-range="${k}">${RANGE_PRESETS[k].label}</button>`).join('')}
      </div>
      <div class="seg cat-seg">
        ${[['', '全大类'], ...CATEGORIES.map((c) => [c.name, c.name])].map(([v, label]) =>
          `<button type="button" class="seg-btn${statsCat === v ? ' on' : ''}" data-stats-cat="${esc(v)}">${esc(label)}</button>`).join('')}
      </div>
      <p class="hint">时间：${esc(rangeLabel(statsRange))} · 大类：${scopeText}</p>
    </div>`;

  if (!allOrders.length) {
    box.innerHTML = rangeCard + '<div class="empty">还没有数据，去「添加」上传第一单吧</div>';
    return;
  }

  // 大类先过一遍：它和统计范围一起决定整页看的是哪一撮单。
  // 月度汇总那块刻意用**全部数据**（它是全局背景，不跟时间一起缩），
  // 但**要跟大类缩** —— 在「餐饮」视图里摆一条全品类的月花费曲线，口径就对不上了。
  const catOrders = statsCat ? allOrders.filter((o) => catOf(o) === statsCat) : allOrders;

  const win = RANGE_PRESETS[statsRange].get(new Date());
  // 后面全部统计都基于裁剪后的订单。这里刻意复用 orders 这个名字，
  // 免得把下面十几处引用逐个改名 —— 漏掉一处就是一处静默的错误数据。
  const orders = win ? catOrders.filter((o) => orderInRange(o.date, win)) : catOrders;

  if (!orders.length) {
    box.innerHTML = rangeCard +
      `<div class="empty">${esc(rangeLabel(statsRange))}${statsCat ? ' · ' + esc(statsCat) : ''} 里没有订单<br>换个范围或大类看看</div>`;
    return;
  }

  const n = orders.length;
  const total = orders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
  // 没店名的单不该算成一家「店铺」（以前空键会被当一家，店铺数凭空虚增）
  const storeCount = new Set(orders.map(orderKeyOf).filter(Boolean)).size;

  // 月度汇总。这块刻意用全部数据：本月花费和最近 6 个月是「全局背景」，
  // 跟着**时间**范围一起缩会退化成一堆空柱子，看不出节奏。
  // 但**要跟着大类缩** —— 在「餐饮」视图里摆一条全品类的花费曲线，口径就对不上了。
  const months = new Map();
  for (const o of catOrders) {
    const k = monthKey(o.date);
    months.set(k, (months.get(k) || 0) + (Number(o.totalPrice) || 0));
  }
  const now = new Date();
  const curKey = monthKey(now.getTime());
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = monthKey(prev.getTime());
  const cur = months.get(curKey) || 0;
  const prevVal = months.get(prevKey) || 0;
  let delta = '本月暂无记录';
  if (prevVal > 0) {
    const pct = Math.round(((cur - prevVal) / prevVal) * 100);
    delta = pct === 0 ? '与上月持平' : (pct > 0 ? `比上月多 ${pct}%` : `比上月少 ${-pct}%`);
  } else if (cur > 0) {
    delta = '上月没有记录';
  }

  // 最近 6 个月（含本月），补齐没有订单的月份，否则条形图会缺格看不出节奏
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    trend.push({ label: `${d.getMonth() + 1}月`, value: months.get(monthKey(d.getTime())) || 0 });
  }

  // ---- 店铺排行：谁点得最多、谁最花钱 ----
  // 复用 groupByStore 的聚合结果，避免两套口径打架（它已经算好 count）。
  // 第一名不再单独取出来 —— 纪录卡只用订单级的极值，店铺维度由下面两张 TOP5 卡负责。
  const stores = groupByStore(orders).map((s) => ({
    name: s.name,
    count: s.count,
    total: s.list.reduce((a, o) => a + (Number(o.totalPrice) || 0), 0),
  }));
  const byCount = [...stores].sort((a, b) => b.count - a.count || b.total - a.total);
  const byMoney = [...stores].sort((a, b) => b.total - a.total || b.count - a.count);

  // ---- 按天 ----
  const days = groupByDay(orders);
  // 两种模式互斥：选了范围 → 范围本身就是窗口，列出范围内每天（封顶 31 行）；
  // 选了全部 → 才用 7/14/30 天窗口。两者叠加会让人算不清到底在看哪一段。
  let dayList, dayHint, daySeg;
  if (win) {
    dayList = days.slice(0, 31);
    dayHint = `范围内 ${days.length} 天有订单 · 共 ${n} 单 · ¥${total.toFixed(0)}` +
      (days.length > dayList.length ? '（下表只列最近 31 天）' : '');
    daySeg = '';
  } else {
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (statsDays - 1));
    const cutoffKey = dayKey(cutoff.getTime());
    dayList = days.filter((d) => d.key >= cutoffKey);
    const amt = dayList.reduce((s, d) => s + d.amount, 0);
    const cnt = dayList.reduce((s, d) => s + d.count, 0);
    dayHint = `最近 ${statsDays} 天：${dayList.length} 天有订单 · 共 ${cnt} 单 · ¥${amt.toFixed(0)} · 日均 ¥${(amt / statsDays).toFixed(1)}`;
    daySeg = `<div class="seg">${[7, 14, 30].map((d) => `<button type="button" class="seg-btn${statsDays === d ? ' on' : ''}" data-stats-days="${d}">${d} 天</button>`).join('')}</div>`;
  }
  // days 保证非空（上面已排除 0 单的情况），所以可以直接用首元素做初值
  const busiestDay = days.reduce((a, b) => (b.count > a.count ? b : a), days[0]);
  const priciestDay = days.reduce((a, b) => (b.amount > a.amount ? b : a), days[0]);
  const priciestOrder = orders.reduce(
    (a, b) => ((Number(b.totalPrice) || 0) > (Number(a.totalPrice) || 0) ? b : a), orders[0]);

  // ---- 星期分布：把 getDay() 的 0=周日 挪到末尾，让周一排在第一位 ----
  const wd = [1, 2, 3, 4, 5, 6, 0].map((i) => ({ label: WEEK_CN[i], value: 0 }));
  for (const o of orders) {
    const g = new Date(o.date).getDay();
    wd[g === 0 ? 6 : g - 1].value += 1;
  }

  // 平台 / 类型分布（按金额）
  const sumBy = (getKey) => {
    const m = new Map();
    for (const o of orders) {
      const k = getKey(o) || '未填';
      m.set(k, (m.get(k) || 0) + o.totalPrice);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  };
  const byPlatform = sumBy((o) => o.platform);
  const byFood = sumBy((o) => o.foodType).slice(0, 6);

  // 评分分布
  const dist = [1, 2, 3, 4, 5].map((r) => ({
    label: `${r} 分`,
    value: orders.filter((o) => (o.rating || 0) === r).length,
  }));

  box.innerHTML = `
    <div class="sec" id="sec-overview">
    ${rangeCard}
    <div class="stat-grid">
      <div class="stat-card"><b>¥${total.toFixed(0)}</b><span>总花费</span></div>
      <div class="stat-card"><b>${n}</b><span>订单数</span></div>
      <div class="stat-card"><b>¥${(total / n).toFixed(1)}</b><span>平均每单</span></div>
      <div class="stat-card"><b>${storeCount}</b><span>店铺数</span></div>
    </div>
    ${categoryStatsCard(orders, n, statsCat)}
    <!-- 纪录卡只放**订单级**的极值。「点得最多 / 花得最多」原来也在这儿，
         但它们和下面两张 TOP5 卡的第一名是同一个答案 —— 同一页里说两遍，
         既占地方又让人怀疑是不是两套口径。店铺维度全部交给 TOP5。 -->
    <div class="card">
      <div class="stat-head"><span>纪录</span><small>${storeCount} 家店铺</small></div>
      <div class="rec-grid">
        <div class="rec-card"><span>单日最多单</span><b>${busiestDay.count} 单</b><small>${dayLabelFromKey(busiestDay.key)}</small></div>
        <div class="rec-card"><span>单日最贵</span><b>¥${priciestDay.amount.toFixed(0)}</b><small>${dayLabelFromKey(priciestDay.key)} · ${priciestDay.count} 单</small></div>
        <div class="rec-card"><span>最贵的一单</span><b>¥${(Number(priciestOrder.totalPrice) || 0).toFixed(0)}</b><small>${esc(priciestOrder.storeName || '未填店名')} · ${esc(new Date(priciestOrder.date).toLocaleDateString())}</small></div>
      </div>
    </div>
    </div>
    <div class="sec" id="sec-store">
    <div class="card">
      <div class="stat-head"><span>点得最多的店</span><small>TOP 5 · 按订单数</small></div>
      ${rankRows(byCount.slice(0, 5).map((s) => ({ label: s.name, value: s.count, text: `${s.count} 单` })))}
    </div>
    <div class="card">
      <div class="stat-head"><span>花钱最多的店</span><small>TOP 5 · 按总金额</small></div>
      ${rankRows(byMoney.slice(0, 5).map((s) => ({ label: s.name, value: s.total, text: `¥${s.total.toFixed(0)}` })))}
    </div>
    </div>
    <div class="sec" id="sec-time">
    <div class="card">
      <div class="stat-head"><span>每日消费</span><small>只列有订单的天</small></div>
      ${daySeg}
      <p class="hint">${esc(dayHint)}</p>
      ${dayRows(dayList)}
    </div>
    <div class="card">
      <div class="stat-head"><span>星期分布</span><small>按订单数</small></div>
      ${barRows(wd, '')}
    </div>
    <div class="card">
      <div class="stat-head"><span>本月花费</span><small>${scopeText} · ${esc(delta)}</small></div>
      <div class="big-num">¥${cur.toFixed(0)}</div>
      <div class="hint">当前范围内共 ${storeCount} 家店铺有记录</div>
    </div>
    <div class="card">
      <div class="stat-head"><span>最近 6 个月</span><small>${scopeText} · 全部时间</small></div>
      ${barRows(trend, '¥')}
    </div>
    </div>
    <div class="sec" id="sec-dist">
    <div class="card">
      <div class="stat-head"><span>平台分布（按金额）</span></div>
      ${barRows(byPlatform, '¥')}
    </div>
    <div class="card">
      <div class="stat-head"><span>小类分布（按金额）</span></div>
      ${barRows(byFood, '¥')}
    </div>
    <div class="card">
      <div class="stat-head"><span>评分分布（按订单数）</span></div>
      ${barRows(dist, '')}
    </div>
    </div>`;
}

// ---------- 待点评（想吃清单） ----------
// 排序 / 搜索状态。刻意**不持久化**：这一页的默认视图「按心动度」就是最有用的
// 那个排序，记住上次选了「按加入时间」反而让人下次进来找不到重点。
let wishSort = 'priority';
let wishQ = '';

/** 心动度三档。库里存 1/2/3，界面上是三个词 + 三种颜色。 */
const PRI = { 1: ['有点想', 'p1'], 2: ['想吃', 'p2'], 3: ['超想吃', 'p3'] };

/**
 * 「加入 3 天前」这类相对时间。只用在待点评卡片上 ——
 * 订单卡片显示的是购买日期本身（用户会补录前几天），两处口径不一样，别混用。
 */
function relDay(ts) {
  const d = Math.floor((Date.now() - Number(ts || 0)) / 86400000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return d + ' 天前';
  const m = Math.floor(d / 30);
  if (m < 12) return m + ' 个月前';
  return Math.floor(d / 365) + ' 年前';
}

function wishCard(w) {
  const [label, cls] = PRI[w.priority] || PRI[2];
  // 元信息行：空字段不留分隔点（地点是选填的，不处理会出现「·  ·」）
  const sub = [w.city, w.category, w.foodType].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="wish">
      <div class="wish-head">
        <div>
          <div class="wish-name">${esc(w.storeName || w.foodType || '未填名称')}</div>
          <div class="wish-sub">${sub}</div>
        </div>
        <span class="pri ${cls}">${label}</span>
      </div>
      ${w.want ? `<div class="wish-want"><span>想吃</span>${esc(w.want)}</div>` : ''}
      ${w.reason ? `<div class="wish-reason">${esc(w.reason)}</div>` : ''}
      <div class="wish-meta">加入 ${relDay(w.createdAt)}</div>
      <div class="wish-actions">
        <button type="button" class="wish-go" data-go="${esc(w.id)}">吃过了，去点评</button>
        <button type="button" class="wish-del" data-del="${esc(w.id)}">删除</button>
      </div>
    </div>`;
}

function visibleWishes() {
  const q = wishQ.trim().toLowerCase();
  const hit = (w) => [w.storeName, w.city, w.foodType, w.want, w.reason]
    .map((x) => String(x == null ? '' : x)).join(' ').toLowerCase().indexOf(q) !== -1;
  // 必须 slice/filter 出一份副本再排 —— 直接 sort(wishes) 会把缓存也排乱，
  // 切页回来时看到的顺序就和上一次的选择对不上了
  const list = q ? wishes.filter(hit) : wishes.slice();
  // 同级按加入时间倒序：新攒的排前面，符合「最近最想吃什么」的直觉
  return list.sort((a, b) => wishSort === 'priority'
    ? ((b.priority || 2) - (a.priority || 2)) || (b.createdAt - a.createdAt)
    : (b.createdAt - a.createdAt));
}

function renderWishes() {
  const list = visibleWishes();
  const total = wishes.length;
  const hot = wishes.filter((w) => w.priority === 3).length;
  const countEl = $('#w-count'), extraEl = $('#w-extra');
  const sorter = $('#w-sort'), searcher = $('#wq');
  if (countEl) countEl.textContent = total ? list.length + ' 家在等着去' : '';
  if (extraEl) extraEl.textContent = total ? `共 ${total} 家 · ${hot} 家超想吃` : '';
  // 一条都没有时搜索框和排序器只是占地方，一起收掉；
  // 但「有条件却没筛出结果」时它们必须留着，否则用户没法把自己搜回来
  if (sorter) sorter.hidden = !total;
  if (searcher) searcher.hidden = !total;
  const box = $('#wish-list');
  if (box) {
    box.innerHTML = list.length
      ? list.map(wishCard).join('')
      : `<div class="empty">${total
        ? '没有匹配的'
        : '还没有想吃的<br>点上面的「＋ 添加想吃的」记一条'}</div>`;
  }
}

/** 「吃过了」带过来的提示条。传空字符串即收起。 */
function showWishBanner(text) {
  const b = $('#wish-banner');
  if (!b) return;
  if (text) {
    const t = $('#wish-banner-text');
    if (t) t.textContent = text;
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

// 「吃过了，去点评」带过来的那条待点评 id，保存订单后凭它精确删除
let pendingWishId = null;

/**
 * 待点评 → 订单的闭环入口。
 *
 * 预填的只有待点评真的拥有的那几格（店名 / 地点 / 大类 / 小类 / 想吃什么）。
 * 平台、总价、人数、评分、图片一律不预设 —— 待点评里根本没有这些值，
 * 而 resetForm 已经把上一次的表单清干净，它们会从「空白 + 字段默认值」开始。
 *
 * 保存后**按 id 精确删**，不比对店名：用户很可能在录单时把
 * 「老潼关肉夹馍」补全成「老潼关肉夹馍(学府路店)」，按名字匹配就会留下
 * 一条谁也删不掉的僵尸记录。
 */
function goReview(id) {
  const w = wishes.find((x) => x.id === id);
  if (!w) return;
  // 先清空再回填：用户可能是从半截的另一张单子过来的，
  // 留着上一次的价格 / 评分 / 图片会串进这一单，比丢掉一张草稿更容易出错
  resetForm();
  pendingWishId = id;
  $('#storeName').value = w.storeName || '';
  $('#city').value = w.city || '';
  // 程序化赋值不会触发 change，支持清单得手动补一次 ——
  // 不补的话，那家店以前配过的支持项在表单里是空的，看着像没保存过
  loadSupForStore(true);
  // 大类必须先设：它决定小类的候选桶和计量方式的默认值
  setFormCategory(w.category, false);
  $('#foodType').value = w.foodType || '';
  // 小类写完之后再定一次形态：上面那次 setFormCategory 跑的时候 foodType 还是空的，
  // 小类评价那格会被判成「没有小类」而收起。顺手也会把它读出来填上。
  applyFormMode();
  $('#items').value = w.want || '';
  renderSuggestAll();
  showWishBanner(`「${w.storeName || w.foodType || '这条待点评'}」保存后自动从待点评移除`);
  switchView('add');
}

/** 删一条待点评。先禁掉按钮：存储卡住时用户会连点，那会开出一串写事务。 */
async function deleteWishById(id, btn) {
  if (btn) btn.disabled = true;
  try {
    await deleteWish(id);
  } catch (err) {
    if (btn) btn.disabled = false;
    toast('删除失败：' + (err && err.message ? err.message : '未知错误'));
    return;
  }
  wishes = wishes.filter((w) => w.id !== id);
  // 删的正好是「吃过了」带过来的那条 → 顺手撤掉 banner。
  // 不撤的话，保存订单时还会去删一条已经不存在的记录，banner 也一直挂着说不通
  if (pendingWishId === id) { pendingWishId = null; showWishBanner(''); }
  renderWishes();
  toast('已删除');
}

// ---------- 视图切换 ----------
function switchView(name) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $$('.tab').forEach((t) => t.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  $(`.tab[data-view="${name}"]`).classList.add('active');
  // 待点评的数据在内存缓存里，切过来重绘一次就够，不用重读数据库
  if (name === 'wish') renderWishes();
  // refreshAll 是 async：不接住它的 reject，列表会静默不刷新且毫无线索
  if (name === 'stores' || name === 'stats') {
    refreshAll().catch((e) => toast('列表刷新失败：' + (e && e.message ? e.message : '未知错误')));
  }
}

async function refreshAll() {
  const orders = await getAll();
  // 老订单里存的还是 `店名|城市`（v3.0.2 之前）—— **读取时统一归一到店名**，
  // 这样分组 / 筛选 / 统计三处不用各自兜底。改的只是内存副本，不写库；
  // 下次编辑保存时自然落成新格式。
  _lastOrders = orders.map((o) => {
    if (o) o.storeKey = orderKeyOf(o);
    return o;
  });
  // 店铺整体评价和订单是两个仓库，读的顺序无所谓，但都要在渲染之前进缓存。
  // indexMeta 顺带把老键（店名|地点）和缺失的 kind 归一，有改动就一次性写回。
  if (indexMeta(await getAllMeta())) await migrateMetaKeys();
  // 待点评：表不存在时 getAllWishes 返回 []，和店铺评价一样兜住，
  // 不让一张表的异常把整轮刷新拖垮
  wishes = await getAllWishes();
  fillFilterOptions(orders);
  // 待点评里记过的地点 / 小类也要进候选池 —— 在清单里打过的值，录单时该能直接点选
  refreshHistory(orders, wishes);
  renderStores(orders);
  renderWishes();
  renderFilterBar();
  renderStats(orders);
}

// ---------- 启动 ----------
(async function init() {
  // 启动阶段过去完全没有兜底：openDB 失败（存储被占用 / 空间不足 / 隐私模式）时
  // 这个 async IIFE 会静默 reject —— 页面渲染正常，但后面的事件一个都没绑上，
  // 表现就是「打开应用点什么都没反应，也不报错」。用 alert 而不是 toast：
  // 此时页面自身的绑定可能还没建立，alert 走原生对话框，一定能看见。
  try {
    db = await openDB();
  } catch (e) {
    alert('无法打开本地数据库：' + (e && e.message ? e.message : '未知错误') +
      '\n\n数据无法保存或读取。请检查系统存储空间后重启应用。');
    return;
  }
  try {
    bindForm();
    // 待点评和订单表单一起绑：它是同一层的视图，绑不上同样应该立刻说出来，
    // 而不是等用户点进「待点评」页才发现整页没反应
    bindWishForm();
    // 首屏也要把表单形态算一次：否则空表单上「支持的消费方式」块一开始就是展开的、
    // 平台块也不会按「线下」收起 —— 摆着一堆本不该出现的格子。
    applyFormMode();
  } catch (e) {
    alert('界面初始化失败：' + (e && e.message ? e.message : '未知错误'));
    return;
  }
  // async 函数的异常不会冒泡回 addEventListener，必须自己接住，否则失败是静默的
  $('#export-btn').addEventListener('click', () => {
    exportData().catch((e) => toast('导出失败：' + (e && e.message ? e.message : '未知错误')));
  });
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const input = e.target;
    const f = input.files[0];
    if (!f) { input.value = ''; return; }
    // 清空 input 交给 importData 读完再做，别在读的中途清
    importData(f, () => { input.value = ''; });
  });
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#store-list').addEventListener('click', onStoreListClick);
  // 店铺评价输入中：随时存一份草稿，列表重绘后文字不会丢（见 noteDraft 注释）
  $('#store-list').addEventListener('input', (e) => {
    const el = e.target.closest('[data-noteinput]');
    if (!el) return;
    noteDraft[el.getAttribute('data-noteinput')] = el.value;
  });

  // ---- 图集 lightbox ----
  $('#lightbox').addEventListener('click', (e) => {
    // 刚横滑翻过页的那一次 click 是滑动结束的副产品，吃掉它，
    // 否则「翻一张」和「关掉」同时发生 —— 手机上必然踩到
    if (lbSwiped) { lbSwiped = false; return; }
    if (e.target.closest('.lb-nav')) return;   // 点箭头不关窗
    closeLightbox();
  });
  $('#lb-prev').addEventListener('click', () => lbStep(-1));
  $('#lb-next').addEventListener('click', () => lbStep(1));

  // 触摸横滑翻页。用 passive 监听：这里从不 preventDefault，
  // 声明成 passive 能让主线程不被滚动阻塞。
  let lbTouch = null;
  $('#lightbox').addEventListener('touchstart', (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    lbTouch = { x: t.clientX, y: t.clientY };
    lbSwiped = false;
  }, { passive: true });
  $('#lightbox').addEventListener('touchend', (e) => {
    if (!lbTouch) return;
    const from = lbTouch;
    lbTouch = null;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    // 只在「横向位移够大、且明显大于纵向」时翻页：
    // 阈值太松的话，点一下关闭时手指的微小斜移就会误翻一张
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      lbStep(dx < 0 ? 1 : -1);
      lbSwiped = true;
    }
  }, { passive: true });
  // 桌面浏览器 / 外接键盘：WebView 里没焦点时不触发，留着无害
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return;
    if (e.key === 'ArrowLeft') lbStep(-1);
    else if (e.key === 'ArrowRight') lbStep(1);
    else if (e.key === 'Escape') closeLightbox();
  });

  // 统计页的「7 / 14 / 30 天」与「时间范围」切换。
  // 必须委托到 #stats-body 上：整块内容每次 renderStats 都会 innerHTML 重写，
  // 直接绑在按钮上的监听会随旧节点一起被丢掉，点第二下就没反应了。
  $('#stats-body').addEventListener('click', (e) => {
    const dayBtn = e.target.closest('[data-stats-days]');
    if (dayBtn) {
      const d = parseInt(dayBtn.dataset.statsDays, 10);
      if ((d !== 7 && d !== 14 && d !== 30) || d === statsDays) return;
      statsDays = d;
      try { localStorage.setItem(STATS_DAYS_LS, String(d)); } catch (err) { /* 记不住也不影响本次切换 */ }
      renderStats(_statOrders);
      return;
    }
    // 大类与时间范围是平级的：都只改一个状态再整页重绘。
    // 顺序上大类判在前面 —— 两者都从 e.target.closest 起，各自独立不冲突。
    const catBtn = e.target.closest('[data-stats-cat]');
    if (catBtn) {
      const c = catBtn.dataset.statsCat || '';
      if (c === statsCat) return;
      statsCat = c;
      try { localStorage.setItem(STATS_CAT_LS, c); } catch (err) { /* 记不住也不影响本次切换 */ }
      renderStats(_statOrders);
      return;
    }
    const rangeBtn = e.target.closest('[data-stats-range]');
    if (!rangeBtn) return;
    const k = rangeBtn.dataset.statsRange;
    if (!RANGE_PRESETS[k] || k === statsRange) return;
    statsRange = k;
    try { localStorage.setItem(STATS_RANGE_LS, k); } catch (err) { /* 同上 */ }
    renderStats(_statOrders);
  });

  // 统计页的分区导航。导航本身在 #stats-body **外面**（固定 HTML），
  // 所以可以直接绑，不用像上面那样委托 —— 它不会随重绘消失。
  $('#stats-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-anchor]');
    if (!b) return;
    const sec = document.getElementById(b.getAttribute('data-anchor'));
    if (!sec) return;
    // 落点偏移写在 .sec 的 scroll-margin-top 里（要让开吸顶的 topbar 和本导航）
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $$('#stats-nav .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
  });

  // 关键词搜索：只重绘列表，不重读数据库。
  // 用 input 事件（不是 change）才有即时反馈；渲染本身是纯 DOM 操作，几十家店够快。
  $('#q').addEventListener('input', () => {
    $('#q-clear').hidden = !$('#q').value;
    renderStores(_lastOrders);
  });
  $('#q-clear').addEventListener('click', (ev) => {
    $('#q').value = '';
    ev.currentTarget.hidden = true;
    renderStores(_lastOrders);
  });

  // 清空全部数据：危险操作，同样走「点两次」确认
  $('#clear-all').addEventListener('click', function () {
    armConfirm(this, {
      hint: '再点一次确认清空全部数据',
      ask: '确认清空？',
      busy: '清空中…',
      done: '全部数据已清空',
      // clearAll 在一个事务里把订单和店铺评价一起清掉
      run: () => clearAll().then(() => {
        storeMeta = {}; noteDraft = {}; editingNoteKey = null; openReviewKeys = new Set();
      }),
    });
  });

  // 排序：只影响渲染，不必重读数据库
  updateSortUI();
  $('#sort-key').addEventListener('change', () => {
    sortState.key = $('#sort-key').value;
    saveSort(); updateSortUI(); renderStores(_lastOrders);
  });
  $('#sort-dir').addEventListener('click', () => {
    sortState.dir = sortState.dir === 'desc' ? 'asc' : 'desc';
    saveSort(); updateSortUI(); renderStores(_lastOrders);
  });

  // 筛选面板展开 / 收起
  $('#filter-toggle').addEventListener('click', () => {
    const p = $('#filter-panel');
    p.hidden = !p.hidden;
    renderFilterBar();
  });
  // 「更多筛选」低频层（地点 / 平台 / 实际消费方式 / 均价区间）展开 / 收起。
  // ⚠️ **每次显式设 hidden** —— 只在形态切换时设的话，hidden 就没人管了
  // （applyFormMode 踩过这个坑，冒烟 3 条 FAIL）。
  const moreToggle = $('#more-toggle');
  if (moreToggle) moreToggle.addEventListener('click', () => {
    const m = $('#filter-more');
    if (m) m.hidden = !m.hidden;
    renderFilterBar();
  });
  // 条件变更只重绘列表。这里绝不能重跑 fillFilterOptions —— 它会重建 option 并清掉刚选的值
  ['#f-month', '#f-store', '#f-city', '#f-platform', '#f-cat', '#f-food', '#f-channel', '#f-min', '#f-max'].forEach((sel) =>
    $(sel).addEventListener('change', () => { renderStores(_lastOrders); renderFilterBar(); }));
  // 重置：面板里的「重置筛选」和工具条上的「清除筛选」共用 resetFilters()，不写两份。
  $('#f-reset').addEventListener('click', () => { resetFilters(); renderStores(_lastOrders); });
  const clearBtn = $('#filter-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { resetFilters(); renderStores(_lastOrders); });

  // 大类快捷条：它只是 #f-cat 的另一个入口，一行过滤逻辑都不新增。
  // （fillFilterOptions 里大类的候选改成了**恒列三个** —— 否则点一个
  //   「最近没买过」的大类时，赋值会被浏览器拒绝并回落成「全部」，
  //   看起来就是「按了没反应」。）
  $('#cat-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    const v = b.getAttribute('data-cat') || '';
    if ($('#f-cat').value === v) return;
    $('#f-cat').value = v;
    renderStores(_lastOrders); renderFilterBar();
  });

  // 「已选条件」里点一条撤掉它。价格区间是两个输入框，单独处理；
  // 「清除全部」那一条走 resetFilters()（同「重置筛选」/「清除筛选」一个出口）。
  $('#filter-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    const sel = c.getAttribute('data-chip');
    if (sel === '#f-price') { $('#f-min').value = ''; $('#f-max').value = ''; }
    else if (sel === '#f-all') { resetFilters(); renderStores(_lastOrders); return; }
    else { const el = $(sel); if (el) el.value = ''; }
    renderStores(_lastOrders); renderFilterBar();
  });
  // 下单日期默认今天。必须在运行时算，写死在 HTML 的 value 里第二天就是错的。
  // max 交给原生日历去限制，避免选到未来日期。
  const dateInput = $('#orderDate');
  if (dateInput) {
    dateInput.value = dayKey(Date.now());
    dateInput.setAttribute('max', dayKey(Date.now()));
    dateInput.addEventListener('change', renderDateQuick); // 原生日历选完要同步高亮
  }
  // 三个自由输入的字段边打边筛历史标签（消费方式 v3.0 改成下拉，已退出这一套）
  ['#city', '#platform', '#foodType'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('input', () => renderSuggest(el.id, el.id));
  });
  // 标签点击。必须委托到表单上 —— 标签是 renderSuggest 整块重建的，
  // 逐个绑监听会随旧节点一起被丢掉（和统计页天数切换同一个坑）。
  // 另外刻意**不做失焦收起**：那样会先 blur 再 click，
  // tag 还没被点到就被藏起来，手机上等于点不动。标签就在表单里，常驻不碍事。
  $('#order-form').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sug-for]');
    if (chip) applySugChip(chip);
  });

  if (hasDraft()) {
    try { writeForm(JSON.parse(localStorage.getItem(DRAFT_KEY))); showDraftBanner(true); } catch (e) { /* ignore corrupt draft */ }
  }
  // PWA 离线缓存：仅在真·安全上下文注册（localhost / https 域名）。
  // APK 内用 WebViewAssetLoader 的 https 虚拟域，资源已内嵌离线，无需 SW，跳过以免 404。
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !location.hostname.includes('androidplatform')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 失败属预期，忽略 */ });
  } else if ('serviceWorker' in navigator) {
    // APK 内不装 SW，并且主动清掉历史遗留的。
    // sw.js 是 cache-first 且缓存名写死（waimai-v1），一旦注册成功，
    // 换 APK 也不会失效 —— sw.js 内容没变 → 不触发 install → 永远不会重新取资源，
    // 页面会被永久钉在首次缓存的那版上。清掉才能保证「装了新版真的生效」。
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => { /* 忽略 */ });
    if (window.caches && caches.keys) {
      caches.keys()
        .then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
        .catch(() => { /* 忽略 */ });
    }
  }
  // 首次渲染失败也要说出来，否则打开就是「空白且无任何线索」
  await refreshAll().catch((e) => toast('读取数据失败：' + (e && e.message ? e.message : '未知错误')));
})();

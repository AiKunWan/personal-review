# 个人点评（Personal Review）

离线优先的消费记录与点评工具：**PWA（原生 JS + IndexedDB）+ Android WebView 壳**。
数据全部留在本机，支持 JSON 导出 / 导入，不依赖任何后端。

当前版本 **v3.2.0（versionCode 30200）**。

## 功能

- **订单录入**：店铺名选填、评分支持小数、日期可改、份数 / 重量（斤）两种计价模式
- **结构化管理**：大类（餐饮 / 生鲜等）+ 小类、实际消费方式、地点、平台多维度平级筛选
- **同款归组**：渲染时按 9 个字段（不含日期）自动归组，一条记录都不动库
- **待点评清单**：吃过未评的订单集中提醒，一键转点评
- **店铺页**：按店铺聚合、店铺整体评价与备注、纯店名身份（地点不参与身份）
- **统计页**：大类 / 分类维度统计
- **覆盖安装友好**：applicationId 固定 `com.waimai.app`，签名密钥固定，versionCode 单调递增

## 仓库结构

```
├── index.html / app.js / style.css / sw.js / manifest.webmanifest   # PWA 源码（唯一真源）
├── smoke_test.js            # Node 冒烟测试
├── check_refs.py            # DOM id / 引用一致性检查
├── verify_apk.py            # APK 解包校验（applicationId / 签名指纹 / versionCode）
├── release.py               # 发版助手：复制产物 + 跑校验
├── tools/
│   ├── bump_version.py      # 升版本号（versionName / versionCode 联动）
│   └── sync_src.py          # 把根目录 5 个源码文件同步到 android assets
├── android-project/         # Android 壳（WebView + WebViewAssetLoader）
│   └── .github/workflows/build-apk.yml   # GitHub Actions 自动构建 APK
└── 项目经历-个人点评.md      # 项目说明（简历向）
```

> `android-project/app/src/main/assets/` 不入库：那是根目录源码的构建镜像，
> 由 `tools/sync_src.py` 同步，避免双份维护走样。

## 本地运行 PWA

任意静态服务器均可（Service Worker 要求 http(s)，不能直接 file:// 打开）：

```bash
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 构建 APK

**方式一：GitHub Actions** —— 仓库 Actions 页手动触发 `Build APK` workflow，产物在 Artifacts 里（debug 签名）。

**方式二：本地** —— Android Studio 打开 `android-project/`，或：

```bash
cd android-project
gradle assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

## 版本规则

- `versionCode = major*10000 + minor*100 + patch`（3.2.0 → 30200），**必须单调递增**，否则系统拒绝覆盖安装
- 改版本：`python tools/bump_version.py <版本号>`，再手动同步页面顶部 `.ver` 显示
- 发版后跑 `python release.py <版本号> <说明>` 自动校验

## 注意事项

- **签名 keystore 不在仓库里**。覆盖安装要求「同 applicationId + 同签名」，换了签名只能卸载重装、数据全丢。自己构建 release 包请生成自己的 keystore 并改 `app/build.gradle` 的 `signingConfigs`
- `release.py` / `tools/bump_version.py` 里保留了原开发机（Windows E 盘）的路径，移植到别的环境时按需改路径即可，逻辑不变
- 预览截图、UI 方案稿、历史 APK 均未入库，保持仓库干净

## 技术栈

原生 HTML/CSS/JS（无框架）· IndexedDB · Service Worker · WebViewAssetLoader · Kotlin · Gradle

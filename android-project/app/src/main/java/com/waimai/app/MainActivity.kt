package com.waimai.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /**
     * 未决的文件选择回调。
     * WebView 要求每个 onShowFileChooser 的 callback 必须被消费一次；
     * 上一个没消费掉会永久堵死后续所有选择请求，所以新请求到来前先把它作废。
     */
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    /**
     * 相册/文件选择器。走 SAF(ACTION_GET_CONTENT)，不需要任何存储权限。
     * 用 registerForActivityResult 而非老式 startActivityForResult —— 前者在
     * Activity 重建后能自动恢复回调，后者会丢结果。
     */
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = pendingFileCallback
        pendingFileCallback = null
        cb?.onReceiveValue(extractUris(result.resultCode, result.data))
    }

    /** 从选择器返回值里取 URI：单选在 data.data，多选在 clipData */
    private fun extractUris(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || data == null) return null
        data.clipData?.let { clip ->
            return Array(clip.itemCount) { clip.getItemAt(it).uri }
        }
        return data.data?.let { arrayOf(it) }
    }

    /**
     * 导出桥。
     *
     * 页面里 `<a download>` + `blob:` 那套在 WebView 里是**完全静默失败**的：
     * ① 没设 DownloadListener → 下载请求直接丢弃；
     * ② 就算设了，blob: scheme 也不能交给 DownloadManager（它只吃 http/https）。
     * 而页面会无条件弹「已导出」，用户以为成功了 —— 实际文件从没写出来过。
     *
     * 所以导出走原生：把 JSON 通过桥交给这里，写进系统公共「下载」目录。
     *
     * 注意 @JavascriptInterface 方法跑在 WebView 的 JavaBridge 线程，不是主线程，
     * 所以这里做文件 IO 既不会卡 UI 也不会 ANR。
     */
    private inner class ExportBridge {
        @JavascriptInterface
        fun export(fileName: String, content: String): String {
            return try {
                val safe = fileName
                    .replace(Regex("[\\\\/:*?\"<>|]"), "_")
                    .ifBlank { "waimai-backup.json" }
                "OK:" + writeToDownloads(safe, content.toByteArray(Charsets.UTF_8))
            } catch (t: Throwable) {
                "ERR:" + (t.message ?: t.javaClass.simpleName)
            }
        }
    }

    /** 写入系统「下载」目录，返回给用户看的路径 */
    private fun writeToDownloads(fileName: String, bytes: ByteArray): String {
        // Android 10+：MediaStore 写公共下载目录，免任何权限，
        // 文件在「文件管理 → 下载」直接可见，且卸载 App 不会被连带删除
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("系统拒绝写入下载目录")
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: throw IllegalStateException("无法打开输出流")
            } catch (t: Throwable) {
                contentResolver.delete(uri, null, null) // 写失败别留半截空文件
                throw t
            }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            return "下载/$fileName"
        }
        // Android 8~9 没有 MediaStore.Downloads，降级到应用外部目录兜底
        // （同样免权限，但路径深、卸载即删）
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: cacheDir
        val f = File(dir, fileName)
        FileOutputStream(f).use { it.write(bytes) }
        return f.absolutePath
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)

        // 把 assets/ 目录映射为 https://appassets.androidplatform.net/assets/
        // 用 https 虚拟域让 WebView 的 IndexedDB / 存储 API 正常工作（file:// 下会失效）
        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // 选择器交回的是 content:// URI，必须允许 WebView 读它，
            // 否则 FileReader 拿不到数据、canvas 也会被污染
            allowFileAccess = true
            allowContentAccess = true

            // 永久禁用 WebView 的资源缓存。
            // 本应用所有资源都在 APK 里（外部链接一律交给系统浏览器），缓存**没有任何收益**，
            // 却会在覆盖安装时留下上一版的 index.html / app.js / style.css ——
            // 现象是「升级了但界面还是旧的」，且不报错、无从排查，是本项目踩过的同类坑里最隐蔽的一种。
            cacheMode = WebSettings.LOAD_NO_CACHE
        }

        webView.webChromeClient = object : WebChromeClient() {

            // 把页面的 alert / confirm 映射成原生对话框。
            // 不实现的话 confirm() 会静默返回 false（删除等操作看起来"没反应"）。
            override fun onJsAlert(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                if (result == null) return false
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setCancelable(false)
                    .setPositiveButton("知道了") { _, _ -> result.confirm() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                if (result == null) return false
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setCancelable(false)
                    .setPositiveButton("确定") { _, _ -> result.confirm() }
                    .setNegativeButton("取消") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }

            /**
             * 关键修复：<input type="file"> 在 WebView 里没有任何默认行为，
             * 必须由客户端自己拉起系统选择器，否则点击毫无反应
             * （浏览器有原生实现，所以网页版一直是正常的）。
             */
            override fun onShowFileChooser(
                _webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                // 作废上一次未决的回调，避免堵死后续请求
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback

                // createIntent() 会带上页面 accept="image/*" 声明的 MIME 类型
                val intent = try {
                    fileChooserParams?.createIntent()
                } catch (e: Exception) {
                    null
                } ?: Intent(Intent.ACTION_GET_CONTENT).setType("image/*")
                intent.addCategory(Intent.CATEGORY_OPENABLE)

                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (e: ActivityNotFoundException) {
                    // 设备上没有可处理的选择器：必须把回调消费掉，
                    // 否则整页的上传功能会永久失效
                    pendingFileCallback = null
                    filePathCallback?.onReceiveValue(null)
                    false
                }
            }

            /**
             * 把页面 console 转发到 logcat。
             * 页面里的静默失败（我接住的异常、被忽略的 reject）都从这里能看到，
             * 排查时用 `adb logcat -s WaimaiWebView` 即可，不用连电脑调试前端。
             */
            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                Log.w(
                    "WaimaiWebView",
                    "${msg?.message()}  @${msg?.lineNumber()}  ${msg?.sourceId()}"
                )
                return true
            }
        }

        // 拦截请求，交给 AssetLoader 从本地 assets 返回，全程不联网
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return null
                return assetLoader.shouldInterceptRequest(url)
            }

            /**
             * 虚拟域内部的导航交给 WebView 自己处理；外部链接（http/https/tel/mailto）
             * 交给系统应用打开。
             * 不实现的话 WebView 会在原地尝试加载外部地址 —— AssetLoader 返回 null，
             * 结果是**静默白屏**，用户完全不知道发生了什么。
             */
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false
                if (url.host == "appassets.androidplatform.net") return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (e: ActivityNotFoundException) {
                    Toast.makeText(
                        this@MainActivity,
                        "没有可以打开这个链接的应用",
                        Toast.LENGTH_SHORT
                    ).show()
                    true
                }
            }

            /** 主文档加载失败时给出可见提示，否则就是一屏空白、毫无线索 */
            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    Toast.makeText(
                        this@MainActivity,
                        "页面加载失败：" + (error?.description ?: "未知错误"),
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }

        // 导出用：WebView 完不成文件下载，必须把内容交给原生落盘
        webView.addJavascriptInterface(ExportBridge(), "AndroidBridge")

        clearAssetCacheIfUpgraded()

        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    /**
     * 覆盖安装（versionCode 变化）时清一次 WebView 的资源缓存。
     *
     * **只清 HTTP/资源缓存，绝不动用户数据。** IndexedDB 与 localStorage 存在
     * app_webview/IndexedDB、app_webview/Local Storage 下，clearCache 不碰它们 ——
     * 所以覆盖安装后订单数据是完整继承的，这是敢让用户直接覆盖安装的前提。
     * （反例：WebStorage.deleteAllData() 会连存储一起清，**永远不要调它**。）
     *
     * 版本号不依赖 BuildConfig：AGP 8 默认关掉了 buildFeatures.buildConfig，
     * 引用它会编译不过；从 PackageManager 读则始终可用。
     */
    private fun clearAssetCacheIfUpgraded() {
        val installed = try {
            val info = packageManager.getPackageInfo(packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                info.versionCode.toLong()
            }
        } catch (t: Throwable) {
            -1L
        }
        val prefs = getSharedPreferences("app_meta", MODE_PRIVATE)
        if (prefs.getLong(KEY_LAST_VERSION_CODE, -1L) != installed) {
            webView.clearCache(true)
            prefs.edit().putLong(KEY_LAST_VERSION_CODE, installed).apply()
        }
    }

    // 返回键：先退 WebView 历史，再退出 Activity
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    private companion object {
        const val KEY_LAST_VERSION_CODE = "last_version_code"
    }
}

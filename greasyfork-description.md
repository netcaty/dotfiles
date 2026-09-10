# 网页快照 · 登录态页面一键归档

把**当前浏览器里已登录、所见即所得**的页面，一键打包成自包含的单文件 HTML，需要时再上传 archive.org 永久保存。

> archive.org 的 SPN2（`web.archive.org/save/...`）是服务端匿名抓取，**抓不到你的登录态内容**。本脚本在浏览器本地取已渲染的 DOM 并内联资源，才能保真。

## 能做什么

- **自包含单文件 HTML**：图片、CSS、字体全部内联成 data URI，断网双击也能原样打开。
- **自动滚动触发懒加载**：自适应多趟滚动（最多 6 趟），页面边滚边展开也能覆盖到底。
- **绕过图床 CORS**：页面内 fetch 抓不到的图，自动改从扩展层 `GM_xmlhttpRequest` 重取；仍失败会在结果里明确报数量，不静默。
- **上传 archive.org**：浏览器内自建标准 **WARC 1.1** 并 PUT 到 IA 的 S3 接口，item 内同时可附整页分片截图，让详情页直接**可翻页预览**（`mediatype=image` → BookReader）。
- **在线回放直链**：成功后给出 [ReplayWeb.page](https://replayweb.page/) 回放地址（走 `archive.org/cors/` 端点，否则会被 CORS 拦）。
- **上传结果不靠猜**：PUT 响应不明朗时会复验 `archive.org/metadata/<id>`，确认 item 存在就判成功，不会白白重传。

## 怎么用

1. 装好后任意页面右下角出现「存档本页」按钮，**鼠标悬浮**即展开设置面板（点页面空白处收起）。
2. 三个开关，切换即时生效：
   - **仅下载到本地**（默认开）：只存本地，不上传。
   - **存档后同时下载本地副本**（默认关）：关掉时上传成功不再弹保存框。
   - **整页截图**（默认开）：让 archive.org 详情页可直接翻页看。
3. 要上传就去 [archive.org/account/s3.php](https://archive.org/account/s3.php) 申请 Access / Secret Key，填进设置面板（存在脚本管理器里，更新脚本不丢）。

## 已知限制

- **回放里图片是否正常，只取决于有没有内联成 data URI**。WARC 只有 HTML 一条记录，ReplayWeb 不回源，残留外链一律坏图。所以「本地打开图片正常」不等于「归档成功」。
- 截图走 SVG `foreignObject` 重绘，不是像素级复制：外部 `@font-face` 字体会回退，`sticky` / `fixed` 元素按静态位置渲染。**截图只当预览，保真件是 WARC。**
- archive.org 的 "No Preview Available" 是政策限制：含 WARC 的 item 必须位于白名单集合才会进 Wayback 索引，普通用户无权上传。本脚本用「WARC + 分片截图 + `mediatype=image`」绕开它。
- 需要 `@connect *`：抓任意图床域名，无法收敛成固定域名白名单。

## 权限说明

- `GM_xmlhttpRequest`：内联跨域资源 + 上传 archive.org。
- `GM_getValue / GM_setValue`：保存 S3 key 与开关状态。
- `GM_notification`：存档结果提醒（主要反馈已改为页内浮层）。
- 不收集、不上传任何数据到你填写的 archive.org 之外的第三方；S3 key 只存在本机脚本管理器里。

## 许可证

MIT

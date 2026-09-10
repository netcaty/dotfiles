// ==UserScript==
// @name         Archive.org Snapshot Helper
// @name:zh-CN   Archive.org 归档助手
// @name:en      Archive.org Snapshot Helper
// @namespace    https://github.com/netcaty
// @version      0.8.4
// @description  One-click archive of the current page (logged-in content included) as a self-contained single-file HTML, with optional upload to archive.org for permanent storage. Can redact personal info such as nicknames and avatars before archiving.
// @description:zh-CN 一键归档当前页面（包括已登录的页面），打包成自包含单文件 HTML，并可一键上传 archive.org 永久保存。支持在归档前标注并打码昵称、头像等个人信息。
// @description:en One-click archive of the current page (logged-in content included) as a self-contained single-file HTML, with optional upload to archive.org for permanent storage. Can redact personal info such as nicknames and avatars before archiving.
// @author       netcat
// @license      MIT
// @homepageURL  https://github.com/netcaty/dotfiles
// @supportURL   https://github.com/netcaty/dotfiles/issues
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      s3.us.archive.org
// @connect      archive.org
// @connect      *
// @compatible   chrome  Requires Tampermonkey or Violentmonkey
// @compatible   edge    Requires Tampermonkey or Violentmonkey
// @compatible   firefox Requires Tampermonkey or Violentmonkey (Greasemonkey 4 lacks GM_xmlhttpRequest)
// ==/UserScript==
//
// 关于 @connect *：抓取页面里的跨域图片 / CSS 需要它。页面内 fetch 受 CORS 限制
// （图床基本不返回 Access-Control-Allow-Origin），内联失败后要靠 GM_xmlhttpRequest
// 从扩展层重取，域名不固定，所以只能通配。

(function () {
  'use strict';

  // 只在顶层页面运行：iframe 里不需要悬浮按钮，重复注入还会互相遮挡。
  // （@noframes 已声明，这里再兜一层，兼容不识别该指令的脚本管理器。）
  if (window.top !== window.self) return;

  // ============================================================
  //  配置：archive.org 自动上传
  //  ------------------------------------------------------------
  //  推荐把鼠标移到右下角「存档本页」按钮上展开设置面板填写 S3 key（会存到 Tampermonkey 存储，
  //  更新脚本不丢失）。下方常量仅作默认值/兼容旧用法，一般留空即可。
  //  Key 申请：https://archive.org/account/s3.php
  // ============================================================
  const IA_S3_ACCESS_KEY_DEFAULT = ''; // 默认 Access Key（留空，改用设置面板）
  const IA_S3_SECRET_KEY_DEFAULT = ''; // 默认 Secret Key（留空，改用设置面板）
  const GM_KEY_ACCESS = 'ia_s3_access';
  const GM_KEY_SECRET = 'ia_s3_secret';
  const GM_KEY_DOWNLOAD_ONLY = 'download_only';
  const GM_KEY_KEEP_LOCAL = 'keep_local';
  const GM_KEY_SHOTS = 'enable_shots';
  const GM_KEY_REDACT = 'redact_enabled';       // 隐私打码总开关（默认关，不改变原有行为）
  const GM_KEY_REDACT_MAP = 'redact_selectors'; // { "<hostname>": ["<css selector>", ...] }
  const IA_COLLECTION = 'opensource'; // 个人上传公开集合
  const IA_MEDIATYPE_WEB = 'web';     // 纯 WARC：语义正确，但 IA 详情页就是 "No Preview Available"
  const IA_MEDIATYPE_IMAGE = 'image'; // 带截图：详情页走 BookReader 图片查看器，可翻页

  // 写进 archive.org item description 的工具署名，方便从归档反查是哪来的。
  // URL 不带语言前缀：GF 会按访客语言自动重定向（实测 /zh-CN/ 与 /en/ 都是 301 到同一页）。
  const TOOL_NAME = 'Archive.org Snapshot Helper';
  const TOOL_URL = 'https://greasyfork.org/scripts/595193';

  // 截图相关上限
  const SHOT_WIDTH = 1280;   // 渲染宽度（px）
  const SHOT_SLICE_H = 2200; // 单片理想高度（px）
  const SHOT_MAX_SLICES = 12; // 最多切片数；超了就自动加高每片，而不是丢内容
  const SHOT_QUALITY = 0.9;  // JPEG 质量。用 JPEG 而非 PNG：体积小 3~5 倍，IA 派生缩略图更快

  // 「仅下载」开关：默认开启（true = 只存本地，不上传 archive.org）
  function getDownloadOnly() {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(GM_KEY_DOWNLOAD_ONLY, true) !== false;
      }
    } catch { /* ignore */ }
    return true;
  }
  function setDownloadOnly(v) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(GM_KEY_DOWNLOAD_ONLY, Boolean(v)); return true; }
    } catch { /* ignore */ }
    return false;
  }

  // 「存档后同时下载本地副本」：默认关闭。
  // 关闭「仅下载」走存档时，默认只上传、不落本地文件（否则每次存档都弹保存框，很容易被误解成上传失败）。
  function getKeepLocal() {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(GM_KEY_KEEP_LOCAL, false) === true;
      }
    } catch { /* ignore */ }
    return false;
  }
  function setKeepLocal(v) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(GM_KEY_KEEP_LOCAL, Boolean(v)); return true; }
    } catch { /* ignore */ }
    return false;
  }

  // 「存档时生成整页截图」：默认开启。
  // 开：item 里多 N 张分片截图，mediatype=image，archive.org 详情页可直接翻页看。
  // 关：只传 WARC，mediatype=web，详情页仍是 "No Preview Available"，只能用 ReplayWeb 回放。
  // 截图失败不影响 WARC 上传（自动降级为纯 WARC）。
  function getShots() {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(GM_KEY_SHOTS, true) !== false;
      }
    } catch { /* ignore */ }
    return true;
  }
  function setShots(v) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(GM_KEY_SHOTS, Boolean(v)); return true; }
    } catch { /* ignore */ }
    return false;
  }

  // ============================================================
  //  隐私打码：把页面上指定的区域（昵称 / 头像 / 用户信息条…）在归档前抹掉
  //  ------------------------------------------------------------
  //  两个刻意的设计取舍：
  //  ① 打码做在**克隆出来的文档**上，所以 WARC（保真件）和整页截图（由这份 HTML
  //     重绘）两条出口同时生效 —— 只对截图做马赛克是白打，回放里照样能复制文本。
  //  ② 匹配方式是"整块替换成同尺寸纯色块"，不是插入模糊层：模糊层下文本仍在 DOM 里，
  //     仍然可以被选中复制；直接换掉元素则连 src / href 等属性一起消失，
  //     不会留下能从 URL 反查用户身份的痕迹。
  // ============================================================
  function getRedactEnabled() {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(GM_KEY_REDACT, false) === true;
      }
    } catch { /* ignore */ }
    return false;
  }
  function setRedactEnabled(v) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(GM_KEY_REDACT, Boolean(v)); return true; }
    } catch { /* ignore */ }
    return false;
  }
  // 打码规则按域名存：同一站点配一次就长期有效。file:// 等无 hostname 的场景归到 (local)。
  function redactHost() {
    let h = '';
    try { h = location.hostname || ''; } catch { /* ignore */ }
    return (h || '(local)').toLowerCase();
  }
  function getRedactMap() {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(GM_KEY_REDACT_MAP, {});
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      }
    } catch { /* ignore */ }
    return {};
  }
  function setRedactMap(m) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(GM_KEY_REDACT_MAP, m || {}); return true; }
    } catch { /* ignore */ }
    return false;
  }
  function getRedactList(host) {
    const l = getRedactMap()[host || redactHost()];
    return Array.isArray(l) ? l.filter((s) => typeof s === 'string' && s) : [];
  }
  function addRedactSelector(sel, host) {
    host = host || redactHost();
    const m = getRedactMap();
    const l = Array.isArray(m[host]) ? m[host].slice() : [];
    if (!l.includes(sel)) l.push(sel);
    m[host] = l;
    return setRedactMap(m) ? l : null;
  }
  function removeRedactSelector(sel, host) {
    host = host || redactHost();
    const m = getRedactMap();
    const l = (Array.isArray(m[host]) ? m[host] : []).filter((s) => s !== sel);
    if (l.length) m[host] = l; else delete m[host];
    return setRedactMap(m) ? l : null;
  }

  // 最近一次存档结果（持久化，便于在设置面板里回看，不用翻控制台）
  const GM_KEY_LAST_RESULT = 'last_result';
  function setLastResult(text, replayUrl) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(GM_KEY_LAST_RESULT, {
          t: new Date().toLocaleString(),
          text: String(text || ''),
          replayUrl: replayUrl || '',
        });
      }
    } catch { /* ignore */ }
  }
  function getLastResult() {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(GM_KEY_LAST_RESULT, null);
    } catch { /* ignore */ }
    return null;
  }

  // 读取 S3 key：优先 Tampermonkey 存储，回退到脚本顶部默认值
  function getAccessKey() {
    let v = '';
    try { v = (typeof GM_getValue === 'function') ? GM_getValue(GM_KEY_ACCESS, '') : ''; } catch { /* ignore */ }
    if (!v) v = IA_S3_ACCESS_KEY_DEFAULT;
    return String(v || '').trim();
  }
  function getSecretKey() {
    let v = '';
    try { v = (typeof GM_getValue === 'function') ? GM_getValue(GM_KEY_SECRET, '') : ''; } catch { /* ignore */ }
    if (!v) v = IA_S3_SECRET_KEY_DEFAULT;
    return String(v || '').trim();
  }
  function setKeys(access, secret) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(GM_KEY_ACCESS, String(access || '').trim());
        GM_setValue(GM_KEY_SECRET, String(secret || '').trim());
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  // ---------- 工具 ----------
  const log = (...a) => console.log(`[${TOOL_NAME}]`, ...a);

  // 生成文件名的干净时间戳
  function timestamp() {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function safeTitle() {
    let t = (document.title || location.hostname).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
    return t || 'snapshot';
  }

  // ---------- 懒加载触发 ----------
  // 滚动页面到底并回到顶，等待一张加载帧，促使 IntersectionObserver 式懒加载完成。
  // 只对"图片数量多且疑似懒加载"的页面做完整滚动，普通页面尽量少打扰。
  async function triggerLazyLoads() {
    const imgs = document.images;
    const hasWxLazy = Array.from(imgs).some((im) => /wx_lazy|data-src|data-original/.test(
      (im.getAttribute('src') || '') + (im.getAttribute('data-src') || '')
    ));
    const hasLazy = Array.from(imgs).some(
      (im) => (im.getAttribute('data-src') || im.getAttribute('data-original') || '')
        && (!im.getAttribute('src') || im.getAttribute('loading') === 'lazy')
    );
    if (!hasLazy && !hasWxLazy) {
      return; // 无明显懒加载，跳过滚动
    }
    log('检测到懒加载，滚动页面以触发图片加载…');
    const doc = document;
    const scrollStep = () => new Promise((r) => {
      // 每步滚动半屏，用 rAF 走真实滚动以触发 IO
      const h0 = window.scrollY;
      const maxY = Math.max(0, doc.body.scrollHeight - window.innerHeight);
      const target = Math.min(h0 + window.innerHeight * 0.8, maxY);
      window.scrollTo(0, target);
      requestAnimationFrame(() => requestAnimationFrame(r));
    });

    // 滚动策略：多趟扫描，直到"页面高度不再增长 + 没有未加载的懒加载图"。
    // 之所以要循环：懒加载会随滚动逐步展开，页面高度持续变高（如公众号正文、
    // 无限列表），单趟滚到底只能覆盖到第一轮已渲染的高度，后面的图仍未触发。
    const MAX_PASSES = 6;
    let passes = 0;
    for (; passes < MAX_PASSES; passes++) {
      let guard = 0;
      while (guard++ < 300 && (window.scrollY < doc.body.scrollHeight - window.innerHeight - 4)) {
        await scrollStep();
      }
      // 滚到底后等一会儿，让这一轮触发的图真正开始加载 / 触发下一批懒加载
      await new Promise((r) => setTimeout(r, 300));
      // 检查是否还有"未加载"的懒加载图（src 为空或仍是占位）
      const pending = Array.from(doc.images).filter((im) => {
        const lazyHint = im.getAttribute('data-src') || im.getAttribute('data-original');
        if (!lazyHint) return false;
        const src = im.getAttribute('src') || '';
        return !src || /^(data:image\/gif|data:image\/svg)/.test(src) || src === lazyHint;
      });
      // 已到顶且无待加载图 → 说明全展开，提前结束
      if (pending.length === 0 && window.scrollY >= doc.body.scrollHeight - window.innerHeight - 4) {
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 150));
        if (doc.body.scrollHeight <= window.innerHeight) break; // 页面本身不滚动
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 200));
    }
    log(`懒加载触发完成（${passes + 1} 趟）`);
    await new Promise((r) => setTimeout(r, 400)); // 等底部图片 settle
    // 回到顶部，视觉上尽量不打扰用户
    window.scrollTo(0, 0);
  }

  // 懒加载图片的真实地址：优先 data-* 字段，其次 src
  function resolveImgSrc(img) {
    for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-echo', 'data-url']) {
      const v = img.getAttribute(attr);
      if (v && v.trim()) return v.trim();
    }
    return img.getAttribute('src') || '';
  }

  // ---------- 资源抓取并转 data URI ----------
  // 返回 Promise<string>，失败返回原 URL（不阻塞整个保存）
  //
  // 防盗链/反爬要点（实测于 mmbiz.qpic.cn 微信图床）：
  // 内联失败、被迫保留外链的资源列表。本地打开还能靠浏览器直连显示，
  // 但 WARC 里没有对应记录 → ReplayWeb 回放时就是坏图。存档结束时要显式提示数量。
  let inlineFailures = [];

  //  - 服务端放行 Access-Control-Allow-Origin:*，fetch 跨域本身能通；
  //  - 但若请求头不"像真实图片加载"（Accept 非 image/*、Referer 缺失），
  //    服务端会返回 200 但 0 字节的空图。故必须显式模拟 <img> 的真实请求头。
  async function urlToDataUri(url, { timeoutMs = 30000, isStyle = false } = {}) {
    if (!url) return url;
    // 已是 data/blob/about/javascript 等，直接用
    if (/^(data:|blob:|about:|javascript:|vbscript:|chrome-extension:|moz-extension:)/i.test(url)) {
      return url;
    }
    const accept = isStyle
      ? 'text/css,*/*;q=0.1'
      : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
    const isHtmlCt = (ct) => /text\/html|application\/xhtml/i.test(ct || '');

    // ① 页面内 fetch：快，但**受 CORS 限制** —— 图床/CDN 基本都不返回
    //    Access-Control-Allow-Origin，这一步会大量静默失败。
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      // referrerPolicy: 'unsafe-url' 确保跨域也携带完整 Referer（防盗链校验依赖它）
      // credentials:'include' 带上当前站 cookie（登录后才可见的资源靠它）
      // Accept: image/* 模拟 <img> 真实加载头；text/css 模拟 <link rel=stylesheet>
      const res = await fetch(url, {
        credentials: 'include',
        mode: 'cors',
        referrerPolicy: 'unsafe-url',
        signal: ctrl.signal,
        headers: {
          'Accept': accept,
          'Accept-Language': (navigator.language || 'zh-CN') + ',zh;q=0.9',
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // 服务端防盗链常返回 200 但 0 字节空图；或重定向到登录页/404 页（text/html）——都丢弃
      if (blob.size > 0 && !isHtmlCt(ct)) {
        // 用 FileReader 转 base64（比 res.arrayBuffer 更稳，兼容大资源）
        return await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);     // data:...;base64,...
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
      }
      log('页面 fetch 拿到了但内容不可用(0字节/HTML)，转 GM 重试:', url, 'ct=' + ct, 'size=' + blob.size);
    } catch (e) {
      log('页面 fetch 失败(多半是 CORS)，转 GM 重试:', url, e.message);
    }

    // ② GM_xmlhttpRequest：从扩展层发请求，**不受页面 CORS 限制**，且自动带目标域 cookie。
    //    这是修「本地 HTML 图片正常、WARC 回放图片损坏」的关键。
    const viaGm = await gmFetchDataUri(url, accept, timeoutMs);
    if (viaGm) return viaGm;

    // 两条路都失败：HTML 里会留下外链 URL。本地打开还能靠浏览器直连显示，
    // 但 WARC 里没有这条记录，ReplayWeb 回放就是坏图 —— 记下来，结束后提示。
    inlineFailures.push(url);
    log('内联失败，快照里将保留外链（WARC 回放时该资源会显示不出来）:', url);
    return url;
  }

  // 用 GM_xmlhttpRequest 取回资源并转 data URI。失败返回 null（永不 throw）。
  // 需要 @connect * 才能抓任意图床域名。
  function gmFetchDataUri(url, accept, timeoutMs) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') { resolve(null); return; }
      let settled = false;
      const fin = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => fin(null), timeoutMs + 500);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: timeoutMs,
          headers: {
            'Accept': accept,
            'Accept-Language': (navigator.language || 'zh-CN') + ',zh;q=0.9',
          },
          onload: (r) => {
            const b = r.response;
            if (!(r.status >= 200 && r.status < 300) || !b || b.size === 0) { fin(null); return; }
            const rh = typeof r.responseHeaders === 'string'
              ? r.responseHeaders
              : JSON.stringify(r.responseHeaders || '');
            if (/text\/html|application\/xhtml/i.test(rh)) { fin(null); return; }
            const fr = new FileReader();
            fr.onload = () => fin(fr.result);
            fr.onerror = () => fin(null);
            fr.readAsDataURL(b);
          },
          onerror: () => fin(null),
          ontimeout: () => fin(null),
          onabort: () => fin(null),
        });
      } catch { fin(null); }
    });
  }

  // 从给定字符串里抽取 url(...) 引用的资源并逐一内联（用于 <link> href 已单列处理，这里针对 style 里的背景图）
  // 简化：只处理 <style> 与元素 style 属性里的 background(-image):url(...)
  async function inlineCssUrlProps(cssText, baseUrl, { max = 60 } = {}) {
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    const targets = [];
    let m;
    // 先收集，避免异步中改动迭代
    const srcs = [];
    while ((m = re.exec(cssText))) srcs.push(m[2]);
    const seen = new Set();
    let resolved = cssText;
    for (const raw of srcs) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      if (resolved.split('data:').length - 1 > max) break; // 粗略上限
      let abs;
      try { abs = new URL(raw, baseUrl).href; } catch { continue; }
      if (/^(data:|blob:)/i.test(abs)) continue;
      const dataUri = await urlToDataUri(abs);
      if (dataUri !== abs) {
        // 只替换精确匹配的那一个 url(...)
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tokenRe = new RegExp('url\\(\\s*([\'"])?' + esc + '\\1\\s*\\)');
        resolved = resolved.replace(tokenRe, 'url("' + dataUri + '")');
      }
    }
    return resolved;
  }

  // ---------- 整页分片截图 ----------
  // 把已自包含的 HTML 渲染成 N 张 JPEG（每片约 SHOT_SLICE_H 高）。
  //
  // 原理：先把 HTML 装进 srcdoc iframe 让它按真实规则布局并量出全高，
  //   再把序列化后的 DOM 塞进 SVG foreignObject，用 viewBox 的 y 偏移切出每一片，
  //   最后 Image → canvas → toBlob 得到 JPEG。
  //
  // 为什么能 work：SVG 内部禁止加载外部资源、但允许 data URI —— 而本脚本已经把
  //   img / CSS 全部内联成 data URI，恰好填掉了 foreignObject 最大的坑
  //   （外链资源加载不出来 + canvas 被污染导致 toBlob 抛 SecurityError）。
  //
  // 已知限制（重绘而非像素复制）：外部 @font-face 字体会回退成系统字体；
  //   sticky/fixed 元素按静态位置渲染；个别复杂 CSS 会走样。
  //   → 所以截图只当预览件，保真件仍然是 WARC。
  //
  // 返回 Blob 数组（失败返回 []，由调用方降级为纯 WARC 上传）。
  async function captureSlices(html) {
    const W = Math.max(768, Math.min(window.innerWidth || SHOT_WIDTH, SHOT_WIDTH));
    const iframe = document.createElement('iframe');
    // allow-same-origin：保留同源以便读取 contentDocument；不带 allow-scripts，脚本跑不起来
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.style.cssText =
      `position:fixed;left:-100000px;top:0;width:${W}px;height:800px;border:0;` +
      `visibility:hidden;pointer-events:none;`;

    try {
      await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('iframe 加载超时')), 30000);
      iframe.onload = () => { clearTimeout(timer); resolve(); };
      iframe.onerror = () => { clearTimeout(timer); reject(new Error('iframe 加载失败')); };
      (document.body || document.documentElement).appendChild(iframe);
      iframe.srcdoc = html;
    });

    // ★ 关键坑（headless 实测复现）：srcdoc 会导航两次 —— 先渲染空的 about:srcdoc（触发
    //   第一次 onload），再渲染真内容并再次替换文档。iframe.contentDocument 在每次导航后
    //   都会换成**新的文档对象**，所以 onload 后立刻抓到的引用是那个空文档，抓着它轮询
    //   永远等不到内容（实测 20s 仍 bodyLen=0）。必须每轮重新取 contentDocument。
    const t0 = Date.now();
    let idoc = null;
    while (Date.now() - t0 < 20000) {
      let d = null;
      try { d = iframe.contentDocument; } catch { /* 暂时不可访问 */ }
      if (d && d.readyState === 'complete' && d.body &&
          (d.body.childElementCount > 0 || (d.body.textContent || '').trim().length > 0)) {
        idoc = d;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!idoc) throw new Error('iframe 内容未就绪（可能 srcdoc 解析失败）');
    const iwin = iframe.contentWindow;

      // 等未内联的剩余图片（若有）尽量加载完，最多 3s
    await new Promise((r) => setTimeout(r, 300));
    const pendingImgs = Array.from(idoc.images || []).filter((im) => !im.complete);
    if (pendingImgs.length) {
      await Promise.race([
        Promise.all(pendingImgs.map((im) => new Promise((r) => {
          im.addEventListener('load', r, { once: true });
          im.addEventListener('error', r, { once: true });
        }))),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }

    const de = idoc.documentElement;
      let fullH = Math.max(
        de.scrollHeight || 0, de.offsetHeight || 0,
        (idoc.body && idoc.body.scrollHeight) || 0
      );
      fullH = Math.max(200, Math.min(fullH, 60000));
      // 让 iframe 撑到全高，fixed/sticky 元素才会落在真实位置而不是被视口裁剪
      iframe.style.height = fullH + 'px';
      await new Promise((r) => setTimeout(r, 150));

      // 页面底色：深色主题不要被白底顶掉
      let bg = '#ffffff';
      try {
        const c = iwin.getComputedStyle(idoc.body || de).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') bg = c;
      } catch { /* ignore */ }

      // 序列化成 XHTML。去掉 <base>：未内联的相对资源在 SVG 里会指向原站并发请求
      const root = de.cloneNode(true);
      root.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      root.querySelectorAll('base').forEach((b) => b.remove());
      root.style.width = W + 'px';
      root.style.height = fullH + 'px';
      root.style.overflow = 'hidden';
      const xml = new XMLSerializer().serializeToString(root);

      // 切片：优先按理想高度分，超过上限就抬高每片而不是丢内容
      const n = Math.min(SHOT_MAX_SLICES, Math.max(1, Math.ceil(fullH / SHOT_SLICE_H)));
      const sliceH = Math.ceil(fullH / n);
      log(`截图：${W}x${fullH}，分 ${n} 片（每片 ${sliceH}px）`);

      const blobs = [];
      for (let i = 0; i < n; i++) {
        const y = i * sliceH;
        const h = Math.max(1, Math.min(sliceH, fullH - y));
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 ${y} ${W} ${h}">` +
          `<foreignObject x="0" y="0" width="${W}" height="${fullH}">${xml}</foreignObject>` +
          `</svg>`;
        const b = await svgToJpegBlob(svg, W, h, bg);
        if (b) blobs.push(b);
        else log(`第 ${i + 1} 片截图失败，跳过`);
      }
      log(`截图完成：${blobs.length}/${n} 片，合计 ${(blobs.reduce((s, b) => s + b.size, 0) / 1024 / 1024).toFixed(2)} MB`);
      return blobs;
    } catch (e) {
      log('截图失败，将降级为纯 WARC 上传：', e && e.message);
      return [];
    } finally {
      try { iframe.remove(); } catch { /* ignore */ }
    }
  }

  // SVG 字符串 → JPEG Blob。SVG 内任何外链资源都会让 canvas 被污染，
  // 此时 toBlob 抛 SecurityError，捕获后返回 null 由上层跳过该片。
  function svgToJpegBlob(svg, w, h, bg) {
    return new Promise((resolve) => {
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = bg || '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((b) => resolve(b || null), 'image/jpeg', SHOT_QUALITY);
        } catch (e) {
          log('canvas 导出失败（多半是 SVG 里残留了外链资源）：', e && e.message);
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // ---------- WARC 打包 ----------
  // 把单文件 HTML 快照包成标准 WARC 1.1（warcinfo + response 两条记录）。
  // 目的：archive.org 的网页回放器只认 WARC；纯 .html 会显示 "no preview available"。
  //
  // WARC 记录格式（每条）：
  //   <versionLine>\r\n
  //   <header>: <value>\r\n ... \r\n
  //   \r\n
  //   <block>\r\n\r\n
  // 末尾两条 \r\n（记录分隔）。

  // WARC 要求的 base32 编码（RFC 4648，大写，无填充）
  function base32(bytes) {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0, out = '';
    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
  }

  // 纯 JS SHA-1（bytes -> bytes）。
  // 用途：crypto.subtle 只在**安全上下文**（https / localhost）可用，
  // 在 http:// 页面上为 undefined，会导致 WARC 打包失败。这里做兜底。
  function sha1Bytes(bytes) {
    const len = bytes.length;
    const padLen = Math.ceil((len + 9) / 64) * 64;
    const msg = new Uint8Array(padLen);
    msg.set(bytes);
    msg[len] = 0x80;
    const dv = new DataView(msg.buffer);
    const bits = len * 8;
    dv.setUint32(padLen - 8, Math.floor(bits / 4294967296));
    dv.setUint32(padLen - 4, bits >>> 0);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Int32Array(80);
    for (let off = 0; off < padLen; off += 64) {
      for (let j = 0; j < 16; j++) w[j] = dv.getInt32(off + j * 4);
      for (let j = 16; j < 80; j++) {
        const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
        w[j] = (n << 1) | (n >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    odv.setInt32(0, h0); odv.setInt32(4, h1); odv.setInt32(8, h2);
    odv.setInt32(12, h3); odv.setInt32(16, h4);
    return out;
  }

  // 生成 UUID v4，不依赖 crypto.randomUUID（同样只在安全上下文可用）
  function uuid4() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch { /* ignore */ }
    const b = new Uint8Array(16);
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
      else throw new Error('no getRandomValues');
    } catch {
      for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // 计算 sha1 摘要，返回 "sha1:BASE32"
  async function sha1B32(text) {
    const bytes = new TextEncoder().encode(text);
    let digest;
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
        digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
      } else {
        throw new Error('no webcrypto');
      }
    } catch {
      digest = sha1Bytes(bytes); // 非安全上下文（http://）兜底
    }
    return 'sha1:' + base32(digest);
  }

  // 拼一条 WARC 记录：headers 为数组 [[name, value], ...]
  function warcRecord(versionLine, headers, block) {
    const head = headers.map(([k, v]) => `${k}: ${v}`).join('\r\n');
    return `${versionLine}\r\n${head}\r\n\r\n${block}\r\n\r\n`;
  }

  // 构造 WARC 字符串
  async function buildWarc(html, targetUrl, warcDate) {
    const ID = () => `<urn:uuid:${uuid4()}>`;
    const ip = '0.0.0.0';

    // ① warcinfo 记录：描述本次抓取
    const warcinfoId = ID();
    const warcinfoBody =
      `software: ${TOOL_NAME} (userscript)\r\n` +
      `format: WARC File Format 1.1\r\n` +
      `conformsTo: http://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/\r\n` +
      `robots: ignore\r\n` +
      `hostname: ${location.hostname}\r\n` +
      `ip: ${ip}\r\n` +
      `operator: ${TOOL_NAME}\r\n` +
      `isPartOf: self-archive snapshot\r\n`;
    const warcinfo = warcRecord(
      'WARC/1.1',
      [
        ['WARC-Type', 'warcinfo'],
        ['WARC-Date', warcDate],
        ['WARC-Record-ID', warcinfoId],
        ['WARC-Filename', 'snapshot.warc'],
        ['Content-Type', 'application/warc-fields'],
        ['Content-Length', String(new TextEncoder().encode(warcinfoBody).length)],
      ],
      warcinfoBody
    );

    // ② response 记录：把整份 HTML 当作目标 URL 的响应体
    const httpHeaders =
      `HTTP/1.1 200 OK\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `Content-Length: ${new TextEncoder().encode(html).length}\r\n`;
    const block = httpHeaders + '\r\n' + html;
    const blockBytes = new TextEncoder().encode(block);
    const digest = await sha1B32(block);

    const response = warcRecord(
      'WARC/1.1',
      [
        ['WARC-Type', 'response'],
        ['WARC-Target-URI', targetUrl],
        ['WARC-Date', warcDate],
        ['WARC-Record-ID', ID()],
        ['WARC-Payload-Digest', digest],
        ['WARC-Block-Digest', digest],
        ['WARC-IP-Address', ip],
        ['Content-Type', 'application/http; msgtype=response'],
        ['Content-Length', String(blockBytes.length)],
      ],
      block
    );

    return warcinfo + response;
  }

  // ---------- archive.org 自动上传 ----------
  // 用 archive.org S3-like API：PUT 到 s3.us.archive.org/<identifier>/<filename>，
  // 免签名鉴权头 `authorization: LOW access:secret`(官方支持,需 https)，
  // 头 x-archive-auto-make-bucket:1 一键建 item+上传。
  // 返回 Promise<{ok:boolean, url?:string, error?:string}>，永不 throw。
  // key 首尾空格/换行会破坏鉴权，统一 trim（从网页复制粘贴常带入）
  function cleanKey() {
    return getAccessKey();
  }
  function cleanSecret() {
    return getSecretKey();
  }
  function hasIaKeys() {
    return Boolean(cleanKey() && cleanSecret());
  }

  // metadata 头内联中文等非 ASCII：官方建议用 uri(urlencode) 包裹，避免头编码问题
  function metaVal(v) {
    if (!v) return '';
    // 只对含非 ASCII 的做 uri 编码
    return /[^\x00-\x7F]/.test(v) ? 'uri(' + encodeURIComponent(String(v)) + ')' : String(v);
  }

  // 取原页自己的摘要，用作 archive.org item 的 description。
  // 为什么不用自己拼的句子：item 详情页会被搜索引擎收录，用原页摘要能直接对上原主题，
  // 比 "Archived with xxx" 这种通用句更容易被正确归类。
  // 优先 <meta name="description">，其次 og:description；压平空白、截断到 500 字。
  function readPageDescription() {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.getAttribute('content') || '') : '';
    };
    const txt = pick('meta[name="description"]') || pick('meta[property="og:description"]');
    return String(txt).replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  // 生成合法、尽量唯一的 item identifier
  function makeIdentifier() {
    let host = (location.hostname || 'page').replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    host = host.slice(0, 40) || 'page';
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    // 加 2 位随机，降低同秒重复冲突
    const rnd = Math.floor(Math.random() * 100);
    return `snapshot-${host}-${ts}-${rnd}`;
  }

  // ---------- archive.org 相关链接统一在这里拼 ----------
  // 回放必须走 /cors/ 端点：只有它返回 CORS 头，ReplayWeb.page 才 fetch 得动 WARC；
  // 且页面定位参数必须放 hash（#view=replay&url=...），放 query 会被忽略。
  function archiveUrls(identifier, filename, isWarc) {
    const id = encodeURIComponent(identifier);
    const fn = encodeURIComponent(filename);
    const corsUrl = `https://archive.org/cors/${id}/${fn}`;
    return {
      url: `https://archive.org/details/${id}`,
      downloadUrl: `https://archive.org/download/${id}/${fn}`,
      corsUrl,
      viewUrl: isWarc
        ? `https://replayweb.page/?source=${encodeURIComponent(corsUrl)}#view=replay&url=${encodeURIComponent(location.href)}`
        : null,
    };
  }

  // ---------- 向 archive.org 核对 item 是否真的建好了 ----------
  // 为什么需要：IA 的 S3 网关是"先落盘、再返回"的两阶段流程，
  //   - PUT 的响应码不一定能代表最终结果（可能 5xx/0，但 item 已经建了）；
  //   - item 建好后还要几秒才在 metadata 端点可见。
  // 所以响应不明朗时不要急着判失败、更不要立刻重传，先问一次真相。
  function fetchItemMetadata(identifier) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 20000,
        onload: (resp) => {
          if (resp.status !== 200) { resolve({ ok: false, code: 'HTTP ' + resp.status }); return; }
          let json;
          try { json = JSON.parse(resp.responseText || '{}'); } catch { resolve({ ok: false, code: 'bad-json' }); return; }
          const meta = json && json.metadata;
          if (!meta || meta.identifier !== identifier) { resolve({ ok: false, code: 'not-found' }); return; }
          resolve({ ok: true, files: (json.files || []).map((f) => f.name).filter(Boolean) });
        },
        onerror: (e) => resolve({ ok: false, code: 'error:' + ((e && e.error) || 'unknown') }),
        ontimeout: () => resolve({ ok: false, code: 'timeout' }),
      });
    });
  }

  // 轮询等 item 出现，累计约 25s。返回 { confirmed, hasFile, detail }
  async function confirmItemOnArchive(identifier, filename) {
    const waits = [0, 3000, 7000, 15000];
    let lastCode = '';
    for (let i = 0; i < waits.length; i++) {
      if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
      const r = await fetchItemMetadata(identifier);
      if (r.ok) {
        const hasFile = r.files.includes(filename);
        return {
          confirmed: true,
          hasFile,
          detail: `item 已存在（${r.files.length} 个文件）` + (hasFile ? '，含本次上传' : '，但还没看到本次上传的文件'),
        };
      }
      lastCode = r.code;
      log(`[复验 ${i + 1}/${waits.length}] item 暂不可查：${r.code}`);
    }
    return { confirmed: false, detail: `metadata 查询未确认（最后一次：${lastCode}）` };
  }

  // 上传。body 可以是字符串（WARC/HTML）或 Blob（截图）。
  // opts: { mediatype, description, isWarc }
  function uploadToArchive(identifier, filename, body, contentType, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      if (!hasIaKeys()) {
        resolve({ ok: false, error: '未配置 archive.org S3 key（鼠标悬浮右下角按钮展开设置填写）' });
        return;
      }
      const ct = contentType || 'text/html; charset=utf-8';
      const isWarc = /warc/i.test(ct);
      const blob = (body instanceof Blob) ? body : new Blob([body], { type: ct });

      const url = `https://s3.us.archive.org/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
      const title = (document.title || location.hostname + ' - snapshot').slice(0, 200);
      const headers = {
        'Authorization': `LOW ${cleanKey()}:${cleanSecret()}`,
        'x-archive-auto-make-bucket': '1',
        'x-archive-queue-derive': '1',        // 开启派生：让 archive.org 建缩略图/回放索引
        'x-archive-interactive-priority': '1',
        'x-archive-meta-identifier': identifier,
        // mediatype 决定详情页用哪个预览器：image → BookReader 图片查看器（有预览、可翻页）；
        // web → 只认 WARC，普通用户上传的进不了白名单集合，就是 "No Preview Available"。
        'x-archive-meta-mediatype': opts.mediatype || IA_MEDIATYPE_WEB,
        'x-archive-meta-collection': IA_COLLECTION,
        'x-archive-meta-title': metaVal(title),
        'x-archive-meta-description': metaVal(opts.description || readPageDescription() || `Archived with ${TOOL_NAME}. Tool: ${TOOL_URL}`),
        'x-archive-meta-subject': metaVal('web archive; snapshot; warc'),
        'x-archive-meta-originalurl': metaVal(location.href),
        // scanner 直接写脚本发布页：IA 会把 http(s) 值渲染成链接，从 item 页一键回到脚本主页
        'x-archive-meta-scanner': TOOL_URL,
        'Content-Type': ct,
      };
      // 注意：不要传 x-archive-meta-noindex。IA 对 noindex 是"看字段有无"而不是"看值"，
      // 传 'false' 有可能反而被当成开启隐藏。

      log('上传到 archive.org:', url);
      GM_xmlhttpRequest({
        method: 'PUT',
        url,
        headers,
        data: blob,          // Blob 二进制体，跨 Tampermonkey 版本最稳
        timeout: 300000,      // 快照可能数 MB~数十 MB(含 base64)，给足 5 分钟
        onload: (resp) => {
          // 2xx/3xx 即成功；archive 可能返回 200 OK
          const code = resp.status;
          const ok = code >= 200 && code < 300;
          log(`上传响应 ${code}:`, (resp.responseText || '').slice(0, 300));
          if (ok) {
            resolve(Object.assign({ ok: true, httpStatus: code }, archiveUrls(identifier, filename, isWarc)));
          } else {
            resolve({
              ok: false,
              httpStatus: code,
              error: `archive.org 返回 HTTP ${code}: ${(resp.responseText || '').slice(0, 200)}`,
            });
          }
        },
        onerror: (e) => {
          // Tampermonkey 的 onerror 事件对象带 .error，可区分跨域被拒(not_allowed)等
          const reason = (e && e.error) ? String(e.error) : (e ? String(e) : 'unknown');
          log('上传请求错误', e, 'error=', reason);
          let msg = '上传请求失败';
          if (/not_allowed|not allowed|permission|denied/i.test(reason)) {
            msg = 'Tampermonkey 未授权连接 s3.us.archive.org：请在 Tampermonkey 面板 → 本脚本 → 设置 → 用户自定义连接 中，把 s3.us.archive.org 加入"已允许域名"，然后重试。';
          } else if (/timeout/i.test(reason)) {
            msg = '上传请求超时';
          }
          resolve({ ok: false, httpStatus: 0, error: msg + ' (' + reason.slice(0, 120) + ')' });
        },
        ontimeout: () => {
          resolve({ ok: false, httpStatus: 0, error: '上传超时' });
        },
      });
    });
  }

  // archive.org 偶发 503 SlowDown（队列限流），指数退避重试，最多 3 次。
  // 同一 identifier 重试避免建出多个 item。
  //
  // 关键改动（0.6.4）：PUT 响应不明朗时，先向 metadata 端点复验，再决定"成功/重试/失败"。
  // 没有这一步就会出现"item 其实已经建好了，脚本却当成失败、白白重传并降级下载"。
  async function uploadWithRetry(identifier, filename, body, contentType, opts) {
    opts = opts || {};
    const isWarc = /warc/i.test(contentType || '');
    const delays = [10000, 30000, 60000]; // 10s / 30s / 60s
    let last = { ok: false, error: '未尝试' };
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        const sec = Math.round(delays[attempt - 1] / 1000);
        log(`[重试 ${attempt}/${delays.length}] 等待 ${sec}s 后重试…`);
        if (typeof GM_notification === 'function') {
          GM_notification({ text: `archive.org 限流(SlowDown)，${sec}s 后重试…`, title: '网页快照', timeout: Math.min(sec * 1000, 5000) });
        }
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
      last = await uploadToArchive(identifier, filename, body, contentType, opts);
      if (last.ok) return last;

      // 响应不明朗 → 问 IA 要真相。只有"明确没有被接受"的情况才跳过复验：
      // 鉴权失败(401/403)或 Tampermonkey 域名未授权，item 根本不会建。
      // 追加文件（截图）传 skipVerify：item 此时必然已存在，复验会把它误判成成功。
      const definitelyNotAccepted = opts.skipVerify || last.httpStatus === 401 || last.httpStatus === 403 ||
        /未授权连接|HTTP 40[13]/i.test(last.error || '');
      if (!definitelyNotAccepted) {
        const conf = await confirmItemOnArchive(identifier, filename);
        if (conf.confirmed) {
          log('PUT 响应异常，但 metadata 已确认 → 判定为成功。', conf.detail);
          return Object.assign({
            ok: true,
            verified: true,
            note: `（响应码为 HTTP ${last.httpStatus === undefined ? '?' : last.httpStatus} 且 ${conf.detail}，已按成功处理）`,
          }, archiveUrls(identifier, filename, isWarc));
        }
        log('复验未确认 item 存在：', conf.detail);
      }

      // 仅在 SlowDown / 503 / 5xx 时重试；鉴权、参数错误重试也无效
      const retryable = /SlowDown|HTTP 5\d\d|HTTP 503|HTTP 502|HTTP 504/i.test(last.error || '');
      if (!retryable) return last;
    }
    return last;
  }

  // ---------- 主流程 ----------
  // 把已标注的打码区域从克隆里整块换成同尺寸纯色占位块，返回处理数量。
  // 尺寸取自 live 元素（克隆尚未参与布局，量不到），元素顺序在深拷贝里保持一致，
  // 所以两侧 querySelectorAll 的结果按下标一一对应。
  function applyRedactions(clone) {
    const list = getRedactList();
    if (!list.length) return 0;
    const isOurs = (el) => !!(el.closest && el.closest('[data-sps-ui]'));
    let n = 0;
    for (const sel of list) {
      let liveHits, cloneHits;
      try {
        liveHits = Array.from(document.querySelectorAll(sel)).filter((el) => !isOurs(el));
        cloneHits = Array.from(clone.querySelectorAll(sel)).filter((el) => !isOurs(el));
      } catch (e) { log('打码选择器无效，已跳过：', sel, e.message); continue; }
      const m = Math.min(liveHits.length, cloneHits.length);
      if (!m) { log('打码选择器没有命中：', sel); continue; }
      for (let i = 0; i < m; i++) {
        const live = liveHits[i];
        const node = cloneHits[i];
        let w = 0, h = 0, disp = 'block';
        try {
          const r = live.getBoundingClientRect();
          w = Math.round(r.width); h = Math.round(r.height);
          const d = getComputedStyle(live).display;
          if (d === 'inline' || d === 'inline-flex') disp = 'inline-block';
        } catch { /* ignore */ }
        const ph = clone.ownerDocument.createElement('div');
        ph.setAttribute('data-sps-redacted', '1');
        ph.style.cssText = `display:${disp};width:${Math.max(1, w)}px;height:${Math.max(1, h)}px;`
          + 'background:#1f2329;border-radius:4px;';
        node.replaceWith(ph);
        n++;
      }
    }
    return n;
  }

  async function buildSnapshot() {
    log('开始构建快照，当前页:', location.href);
    const started = Date.now();
    const baseUrl = location.href;
    inlineFailures = []; // 每次快照重新统计

    // 0) 先触发懒加载：许多站点（含公众号正文）用 IntersectionObserver 懒加载图片，
    //    必须先把页面滚到底，让所有懒加载资源真正加载进 DOM，快照才不会缺图。
    await triggerLazyLoads();

    // 1) 深拷贝文档，脱离 live DOM，避免后续 mutation 干扰
    const clone = document.documentElement.cloneNode(true);
    const wrap = document.implementation.createHTMLDocument('snapshot');
    wrap.documentElement.replaceWith(clone);

    // 1.5) 隐私打码。必须排在收集图片**之前**：这样被标注的头像连 data URI 都不会生成，
    //      也不会把请求记进 inlineFailures。WARC 与截图共用这一份 HTML。
    let redacted = 0;
    if (getRedactEnabled()) {
      redacted = applyRedactions(clone);
      log(redacted ? `隐私打码：已抹除 ${redacted} 处` : '隐私打码：已开启，但本页没有命中任何标注区域');
    }

    // 收集需要处理的元素
    const imgs = Array.from(clone.querySelectorAll('img'));
    const cssLinks = Array.from(clone.querySelectorAll('link[rel~="stylesheet"]'));
    const inlineStyles = Array.from(clone.querySelectorAll('style'));
    const posterEls = Array.from(clone.querySelectorAll('video[poster]'));
    const styledEls = Array.from(clone.querySelectorAll('[style]')).filter(
      (el) => /url\s*\(/.test(el.getAttribute('style') || '')
    );
    log(`待内联: img=${imgs.length} cssLink=${cssLinks.length} styleTag=${inlineStyles.length} poster=${posterEls.length} elStyle=${styledEls.length}`);

    // 并发度控制：避免一次打爆太多请求
    const pool = 6;
    let idx = 0;
    async function worker() {
      while (idx < imgs.length) {
        const i = idx++;
        const img = imgs[i];
        const src = resolveImgSrc(img);
        if (!src) continue;
        let abs;
        try { abs = new URL(src, baseUrl).href; } catch { continue; }
        const dataUri = await urlToDataUri(abs);
        if (dataUri !== abs) {
          img.setAttribute('src', dataUri);
          img.removeAttribute('srcset');
          img.removeAttribute('srcSet');
          // 清掉懒加载占位字段，避免离线再次走懒加载逻辑
          for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-echo', 'data-url']) {
            img.removeAttribute(attr);
          }
        } else if (!img.getAttribute('src')) {
          // 抓不到但原本只有 data-src：至少把远程地址放回 src，离线时尽力加载
          img.setAttribute('src', abs);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(pool, imgs.length) }, worker));

    // 2) 内联 <link rel=stylesheet>：抓取 CSS 文本转 <style>，并就地内联其中的 url() 资源
    for (const link of cssLinks) {
      let href = link.getAttribute('href');
      if (!href) continue;
      let abs;
      try { abs = new URL(href, baseUrl).href; } catch { continue; }
      if (/^(data:|blob:)/i.test(abs)) continue;
      const dataUri = await urlToDataUri(abs, { isStyle: true });
      if (dataUri === abs) continue; // 抓不到，保留原 link
      try {
        const text = await (await fetch(dataUri)).text(); // data URI 可直接 fetch 回纯文本
        const st = document.createElement('style');
        st.setAttribute('data-src', abs);
        if (link.getAttribute('media')) st.setAttribute('media', link.getAttribute('media'));
        // 就地内联该 CSS 内相对/绝对 url()：以该 CSS 文件目录为 base
        let cssText = text;
        if (/url\s*\(/.test(cssText)) {
          const cssDir = new URL('.', abs).href;
          cssText = await inlineCssUrlProps(cssText, cssDir);
        }
        st.textContent = cssText;
        link.replaceWith(st);
      } catch (e) { log('CSS 文本解析失败', abs, e.message); }
    }

    // 3) 内联 <style> 内与元素 style 属性里的 url() 资源
    //    base 规则：由外部 CSS link 转来的 <style> 带 data-src(原 css 绝对地址)，
    //    其内部相对 url() 须以该 CSS 的目录为基准；页面内联 <style> 则以页面为基准。
    for (const st of inlineStyles) {
      const t = st.textContent;
      if (t && /url\s*\(/.test(t)) {
        const srcAbs = st.getAttribute('data-src');
        let cssBase = baseUrl;
        if (srcAbs) {
          try { cssBase = new URL('.', srcAbs).href; } catch { /* 保持页面 base */ }
        }
        st.textContent = await inlineCssUrlProps(t, cssBase);
      }
    }
    for (const el of styledEls) {
      const s = el.getAttribute('style');
      if (s && /url\s*\(/.test(s)) {
        el.setAttribute('style', await inlineCssUrlProps(s, baseUrl));
      }
    }

    // 4) video poster
    for (const v of posterEls) {
      const src = v.getAttribute('poster');
      if (!src) continue;
      const dataUri = await urlToDataUri(new URL(src, baseUrl).href);
      if (dataUri !== src) v.setAttribute('poster', dataUri);
    }

    // 5) 移除脚本执行标记：克隆里保留 <script> 会在离线打开时重跑，可能请求远程改状态。
    //    为保真保留但禁用其网络行为？这里选择：保留脚本但很多页面重跑会覆盖 DOM。
    //    保守做法：把克隆内的 <script> 和 <iframe> 移除，避免离线时二次请求/重绘导致内容变化。
    //    如果你的页面靠 JS 渲染，删除后快照会空白——见下：我们保留已在 DOM 的内容，删除 script 不影响已渲染 DOM。
    clone.querySelectorAll('script, iframe, noscript, link[rel="preload"], link[rel="prefetch"]')
      .forEach((el) => el.remove());

    // 5.5) 剔除脚本自己注入的 UI（悬浮按钮 / 设置面板 / 结果浮层）。
    //      不剔的话会被一并克隆进快照，而克隆发生在点击之后——按钮文案正处于「存档中…」，
    //      于是打开本地快照时会看到一个永远停在「存档中…」的假按钮，还会带着整个设置面板。
    clone.querySelectorAll('[data-sps-ui], #sps-fab, #sps-settings, #sps-toast')
      .forEach((el) => el.remove());

    // 6) 生成最终 HTML 字符串
    //  用 outerHTML 会丢掉 <html> 自身属性，手动拼
    const cloneHtml = clone.outerHTML;
    const head = clone.querySelector('head');
    const titleTag = head ? head.querySelector('title') : null;
    // base 保持原址：若快照离线打开，未内联的绝对 URL 仍指向原站可加载（尽力而为）
    let baseTag = '';
    try { baseTag = `<base href="${baseUrl.replace(/"/g, '&quot;')}">`; } catch { /* ignore */ }
    const charset = clone.getAttribute('charset') || document.characterSet || 'UTF-8';

    const html = `<!DOCTYPE html>
<!-- Saved by ${TOOL_NAME} @ ${new Date().toISOString()}
   Original URL: ${location.href} -->
<html${clone.getAttribute('lang') ? ` lang="${clone.getAttribute('lang')}"` : ''}>
<head>
<meta charset="${charset}">
${titleTag ? titleTag.outerHTML : ''}
${baseTag}
</head>
${cloneHtml.includes('<body') ? '' : '<body>'}
${cloneHtml}
</html>`;

    const done = Date.now();
    log(`快照构建完成，耗时 ${((done - started) / 1000).toFixed(1)}s，大小 ${(new Blob([html]).size / 1024 / 1024).toFixed(2)} MB`);
    return { html, filename: `${safeTitle()}_${timestamp()}.html`, redacted };
  }

  function downloadSnapshot(html, filename) {
    try {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
      return true;
    } catch (e) {
      log('下载失败', e);
      // 兜底：新窗口 data URI 方式（大文件可能被限）
      try {
        const w = window.open('', '_blank');
        if (w) { w.document.write(html); w.document.close(); }
      } catch (e2) { log('兜底打开失败', e2); }
      return false;
    }
  }

  // ---------- 打码区域点选器 ----------
  // 页面结构千变万化，脚本没能力判断哪个 div 是「当前登录用户」。所以让用户点一次，
  // 由脚本把该元素换算成 CSS 选择器按域名存下来，之后每次归档自动套用。
  function cssPath(el) {
    if (!el || el.nodeType !== 1 || !el.tagName) return '';
    const esc = (s) => (window.CSS && CSS.escape)
      ? CSS.escape(String(s))
      : String(s).replace(/[^\w-]/g, '\\$&');
    const identOk = (s) => /^[A-Za-z][\w-]*$/.test(s);
    const isUnique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };

    if (el.id && identOk(el.id)) {
      const s = '#' + esc(el.id);
      if (isUnique(s)) return s;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && identOk(node.id)) {
        const s = '#' + esc(node.id);
        if (isUnique(s)) { parts.unshift(s); break; }
      }
      let seg = node.tagName.toLowerCase();
      const cls = Array.from(node.classList || []).filter(identOk).slice(0, 2);
      if (cls.length) seg += '.' + cls.map(esc).join('.');
      const parent = node.parentElement;
      if (parent) {
        // 只用 :nth-of-type —— :nth-child 会被无关的兄弟节点带偏
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) seg += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      const test = parts.join(' > ');
      if (isUnique(test)) return test;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // onPick(element, selector) / onCancel()
  function startRedactPicker(onPick, onCancel) {
    if (document.getElementById('sps-pick-hint')) return;

    const hint = document.createElement('div');
    hint.id = 'sps-pick-hint';
    hint.setAttribute('data-sps-ui', '1');
    hint.textContent = '点击要打码的区域（Esc 取消）';
    hint.style.cssText = `
      position: fixed; z-index: 2147483647; left: 50%; top: 16px; transform: translateX(-50%);
      background: #1f2329; color: #fff; font: 600 13px/1 system-ui, sans-serif;
      padding: 11px 18px; border-radius: 22px; box-shadow: 0 8px 28px rgba(0,0,0,.4);
      pointer-events: none; white-space: nowrap;
    `;

    const box = document.createElement('div');
    box.id = 'sps-pick-box';
    box.setAttribute('data-sps-ui', '1');
    box.style.cssText = `
      position: fixed; z-index: 2147483646; display: none; pointer-events: none;
      border: 2px solid #d93025; background: rgba(217,48,37,.14); border-radius: 3px;
    `;

    const root = document.body || document.documentElement;
    root.appendChild(hint);
    root.appendChild(box);

    const isOurs = (el) => !!(el && el.closest && el.closest('[data-sps-ui]'));

    function onMove(e) {
      const t = e.target;
      if (!t || isOurs(t)) { box.style.display = 'none'; return; }
      const r = t.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    }
    // 把点击彻底截留在捕获阶段：页面自身的链接跳转 / 折叠展开都不会被触发
    function swallow(e) { e.preventDefault(); e.stopPropagation(); }
    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const t = e.target;
      if (!t || isOurs(t)) return;
      const sel = cssPath(t);
      cleanup();
      if (sel) onPick(t, sel); else onCancel && onCancel('无法为该元素生成选择器');
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      swallow(e);
      cleanup();
      onCancel && onCancel();
    }
    function cleanup() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('pointerdown', swallow, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('dblclick', swallow, true);
      document.removeEventListener('contextmenu', swallow, true);
      document.removeEventListener('keydown', onKey, true);
      hint.remove();
      box.remove();
      document.documentElement.style.cursor = '';
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('pointerdown', swallow, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', swallow, true);
    document.addEventListener('contextmenu', swallow, true);
    document.addEventListener('keydown', onKey, true);
    document.documentElement.style.cursor = 'crosshair';
  }

  // ---------- 设置面板（随悬浮按钮展开，填写 archive.org S3 key） ----------
  // 返回 { el }，由悬浮按钮容器控制显示/隐藏；不做遮罩、不拦截页面点击。
  function buildSettingsPanel() {
    const el = document.createElement('div');
    el.id = 'sps-settings';
    el.setAttribute('data-sps-ui', '1'); // 打标：克隆快照时剔除，避免污染产物
    el.style.cssText = `
      position: absolute; right: 0; bottom: 50px;
      width: 340px; max-width: calc(100vw - 32px);
      background: #fff; color: #1f2329; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.28); border: 1px solid rgba(0,0,0,.06);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden; display: none;
    `;

    const access = getAccessKey();
    const secret = getSecretKey();
    const dlOnly = getDownloadOnly();
    const keepLocal = getKeepLocal();
    const shotsOn = getShots();
    const redactOn = getRedactEnabled();

    el.innerHTML = `
      <style>
        .hd { padding: 12px 16px; font-weight: 700; font-size: 14px; border-bottom: 1px solid #eceef1; }
        .bd { padding: 14px 16px; max-height: min(66vh, 560px); overflow-y: auto; }
        .row { margin-bottom: 12px; }
        label { display: block; font-size: 12px; color: #646a73; margin-bottom: 6px; }
        input[type=text], input[type=password] {
          width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d3d9;
          border-radius: 8px; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; outline: none;
        }
        input[type=text]:focus, input[type=password]:focus { border-color: #2d6cdf; box-shadow: 0 0 0 3px rgba(45,108,223,.12); }
        .sw { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0 2px; }
        .sw .txt { font-size: 13px; }
        .sw .sub { font-size: 11px; color: #8a9099; margin-top: 2px; }
        .toggle { position: relative; width: 40px; height: 22px; flex: 0 0 auto; }
        .toggle input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
        .slider { position: absolute; inset: 0; background: #cfd3d9; border-radius: 11px; transition: background .15s; pointer-events: none; }
        .slider::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; background: #fff;
          border-radius: 50%; transition: transform .15s; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
        .toggle input:checked + .slider { background: #2d6cdf; }
        .toggle input:checked + .slider::after { transform: translateX(18px); }
        .hint { font-size: 11px; color: #8a9099; margin-top: 8px; line-height: 1.6; }
        .hint a { color: #2d6cdf; }
        .rlist { font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #646a73; }
        .ritem { display: flex; align-items: center; gap: 6px; background: #f6f7f9;
          border-radius: 6px; padding: 5px 6px 5px 8px; margin-bottom: 4px; }
        .ritem code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ritem .del { background: transparent; color: #d4380d; padding: 2px 4px; font-weight: 700; font-size: 12px; }
        .empty { color: #8a9099; font-size: 11px; padding: 0 0 6px; }
        .pick { background: #eef3fd; color: #2d6cdf; width: 100%; margin-top: 2px; }
        .ft { padding: 10px 16px; border-top: 1px solid #eceef1; display: flex; align-items: center; gap: 8px; }
        .status { font-size: 11px; color: #8a9099; flex: 1; }
        button { border: 0; border-radius: 8px; padding: 8px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
        .clear { background: transparent; color: #d4380d; padding: 8px 6px; }
        .save { background: #2d6cdf; color: #fff; }
      </style>
      <div class="hd">网页快照 · 设置</div>
      <div class="bd">
        <div class="row">
          <label>archive.org S3 Access Key</label>
          <input id="access" type="text" spellcheck="false" autocomplete="off" placeholder="Access Key" value="${escapeAttr(access)}">
        </div>
        <div class="row">
          <label>archive.org S3 Secret Key</label>
          <input id="secret" type="password" spellcheck="false" autocomplete="off" placeholder="Secret Key" value="${escapeAttr(secret)}">
        </div>
        <div class="sw">
          <div>
            <div class="txt">仅下载到本地</div>
            <div class="sub">开启后，快照仅保存到本地，不上传 archive.org</div>
          </div>
          <span class="toggle">
            <input id="dlonly" type="checkbox" ${dlOnly ? 'checked' : ''}>
            <span class="slider"></span>
          </span>
        </div>
        <div class="sw">
          <div>
            <div class="txt">存档后同时下载本地副本</div>
            <div class="sub">开启后，上传 archive.org 的同时再下载一份到本地</div>
          </div>
          <span class="toggle">
            <input id="keeplocal" type="checkbox" ${keepLocal ? 'checked' : ''}>
            <span class="slider"></span>
          </span>
        </div>
        <div class="sw">
          <div>
            <div class="txt">存档时生成整页截图</div>
            <div class="sub">开启后，archive.org 详情页可直接翻页预览快照，无需回放工具</div>
          </div>
          <span class="toggle">
            <input id="shots" type="checkbox" ${shotsOn ? 'checked' : ''}>
            <span class="slider"></span>
          </span>
        </div>
        <div class="sw">
          <div>
            <div class="txt">归档时打码隐私信息</div>
            <div class="sub">仅对下方已标注的区域生效，WARC 与截图同时打码</div>
          </div>
          <span class="toggle">
            <input id="redact" type="checkbox" ${redactOn ? 'checked' : ''}>
            <span class="slider"></span>
          </span>
        </div>
        <div class="row" style="margin-top:10px;">
          <label>本域名的打码区域（<span id="redacthost"></span>）</label>
          <div class="rlist" id="redactlist"></div>
          <button class="pick" id="pick" type="button">+ 在页面上点选打码区域</button>
        </div>
        <div class="hint">
          Key 到 <a href="https://archive.org/account/s3.php" target="_blank" rel="noreferrer">archive.org/account/s3.php</a> 免费申请。
          保存在 Tampermonkey 本地存储，更新脚本不会丢失。
        </div>
        <div class="hint" id="lastresult" style="border-top:1px solid #f0f1f3;padding-top:8px;margin-top:10px;"></div>
      </div>
      <div class="ft">
        <span class="status" id="status"></span>
        <button class="clear" id="clear">清除 Key</button>
        <button class="save" id="save">保存</button>
      </div>
    `;

    const $ = (id) => el.querySelector('#' + id);

    // 显示「上次存档结果」，方便定位问题（不用翻控制台）。
    // 结果文本里的 item URL 渲染成可点的直达链接。
    (function renderLast() {
      const lr = getLastResult();
      const box = $('lastresult');
      box.textContent = '';
      if (!lr || !lr.text) { box.textContent = '上次存档：尚无记录'; return; }
      const raw = String(lr.text);
      // 不再把长 URL 整条铺在面板里：抽出来，只留一句可点的文案
      const m = raw.match(/https?:\/\/[^\s，,；;）)]+/i);
      const url = m ? m[0] : '';
      const brief = url ? raw.replace(url, '').replace(/[：:\s]+$/, '') : raw;
      box.appendChild(document.createTextNode(`上次存档（${lr.t}）：${brief}`));
      if (url) {
        box.appendChild(document.createTextNode(' '));
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.textContent = '打开上次归档 ↗';
        a.style.fontWeight = '600';
        a.title = url; // 悬停仍可看到真实地址
        box.appendChild(a);
      }
    })();

    // 打码区域列表：按当前域名展示，可逐条删除
    function refreshRedact() {
      const host = redactHost();
      $('redacthost').textContent = host;
      const box = $('redactlist');
      box.textContent = '';
      const list = getRedactList(host);
      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = '暂无。点下方按钮，回到页面上点要打码的元素。';
        box.appendChild(e);
        return;
      }
      list.forEach((sel) => {
        const row = document.createElement('div');
        row.className = 'ritem';
        const code = document.createElement('code');
        code.textContent = sel;
        code.title = sel;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.textContent = '✕';
        del.title = '删除该打码区域';
        del.onclick = () => {
          removeRedactSelector(sel, host);
          refreshRedact();
          $('status').textContent = '✓ 已删除一条打码区域';
        };
        row.appendChild(code);
        row.appendChild(del);
        box.appendChild(row);
      });
    }
    refreshRedact();

    // 「打码」总开关：切换即保存
    $('redact').addEventListener('change', () => {
      const on = $('redact').checked;
      const okFlag = setRedactEnabled(on);
      $('status').textContent = okFlag
        ? (on ? '✓ 归档时会对已标注区域打码' : '✓ 已关闭打码，归档会保留原样')
        : '保存失败：GM_setValue 不可用';
    });

    // 点选打码区域：隐藏面板 → 进入点选模式 → 存选择器
    $('pick').onclick = () => {
      el.style.display = 'none'; // 面板浮在页面上会挡住目标元素
      startRedactPicker((element, sel) => {
        const list = addRedactSelector(sel);
        if (!list) {
          showResultToast('err', '保存打码区域失败', ['GM_setValue 不可用，规则没能存下来。'], null, 0);
          return;
        }
        // 点了就说明想用 —— 顺手把总开关打开，省得再回面板点一次
        const autoOn = !getRedactEnabled() && setRedactEnabled(true);
        refreshRedact();
        $('redact').checked = true;
        $('status').textContent = '✓ 已添加打码区域';
        showResultToast('ok', '已添加打码区域', [
          sel,
          '之后每次归档都会自动打码（含 WARC 与截图）。' + (autoOn ? '已同时打开「归档时打码隐私信息」。' : ''),
        ], null, 9000);
      }, (msg) => {
        if (msg) showResultToast('info', '已取消打码标注', [msg], null, 6000);
      });
    };

    // 「仅下载」开关：切换即保存，无需点「保存」按钮（避免忘记保存导致不生效）
    $('dlonly').addEventListener('change', () => {
      const only = $('dlonly').checked;
      const okFlag = setDownloadOnly(only);
      $('status').textContent = okFlag
        ? (only ? '✓ 已切换为：仅下载到本地' : '✓ 已切换为：存档时上传 archive.org')
        : '保存失败：GM_setValue 不可用';
    });

    // 「同时下载本地副本」开关：同样切换即保存
    $('keeplocal').addEventListener('change', () => {
      const keep = $('keeplocal').checked;
      const okFlag = setKeepLocal(keep);
      $('status').textContent = okFlag
        ? (keep ? '✓ 存档后会同时下载一份本地副本' : '✓ 存档只上传，不再弹保存框')
        : '保存失败：GM_setValue 不可用';
    });

    // 「整页截图」开关：同样切换即保存
    $('shots').addEventListener('change', () => {
      const on = $('shots').checked;
      const okFlag = setShots(on);
      $('status').textContent = okFlag
        ? (on ? '✓ 存档时会生成整页截图（详情页可直接翻页预览）' : '✓ 存档只传 WARC，不生成截图')
        : '保存失败：GM_setValue 不可用';
    });

    $('clear').onclick = () => {
      $('access').value = ''; $('secret').value = '';
      $('status').textContent = '已清空 Key，点保存生效';
    };
    $('save').onclick = () => {
      const a = $('access').value.trim();
      const s = $('secret').value.trim();
      const only = $('dlonly').checked;
      if ((a && !s) || (!a && s)) {
        $('status').textContent = 'Access 和 Secret 需同时填写';
        return;
      }
      const okKey = setKeys(a, s);
      const okFlag = setDownloadOnly(only);
      const okKeep = setKeepLocal($('keeplocal').checked);
      const okShots = setShots($('shots').checked);
      const okRedact = setRedactEnabled($('redact').checked);
      if (!okKey || !okFlag || !okKeep || !okShots || !okRedact) { $('status').textContent = '保存失败：GM_setValue 不可用'; return; }
      let msg;
      if (only) msg = '✓ 已保存（仅下载到本地）';
      else if (a && s) msg = '✓ 已保存，存档时将上传 archive.org';
      else msg = '已保存，但未填 Key：存档仍只下载本地';
      $('status').textContent = msg;
      if (typeof GM_notification === 'function') GM_notification({ text: msg, title: '网页快照', timeout: 4000 });
    };

    return { el };
  }

  // ---------- 页内结果浮层 ----------
  // 为什么不用 GM_notification：在 Chrome 上它常常不弹/一闪而过，
  // 于是"上传成功 + 顺手下载了本地副本"看起来就和失败一模一样。
  // kind: 'ok' | 'err' | 'info'
  function showResultToast(kind, title, lines, links, timeout) {
    const OLD = 'sps-toast';
    const old = document.getElementById(OLD);
    if (old) old.remove();

    const color = kind === 'ok' ? '#0f9d58' : (kind === 'err' ? '#d93025' : '#2d6cdf');
    const host = document.createElement('div');
    host.id = OLD;
    host.setAttribute('data-sps-ui', '1');
    host.style.cssText = `
      position: fixed; z-index: 2147483647; right: 24px; bottom: 92px;
      width: 380px; max-width: calc(100vw - 48px);
      background: #fff; color: #1f2329; border-radius: 12px;
      box-shadow: 0 10px 34px rgba(0,0,0,.24); overflow: hidden;
      font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
      border-left: 4px solid ${color};
    `;

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px 6px;';
    const dot = document.createElement('span');
    dot.textContent = kind === 'ok' ? '✓' : (kind === 'err' ? '✕' : 'ℹ');
    dot.style.cssText = `color:${color};font-weight:700;font-size:15px;line-height:1;`;
    const ttl = document.createElement('span');
    ttl.textContent = title;
    ttl.style.cssText = 'font-weight:600;flex:1;';
    const close = document.createElement('span');
    close.textContent = '✕';
    close.style.cssText = 'cursor:pointer;color:#8a9099;font-size:12px;padding:2px 4px;';
    close.onclick = () => host.remove();
    head.appendChild(dot); head.appendChild(ttl); head.appendChild(close);

    const body = document.createElement('div');
    body.style.cssText = 'padding:0 14px 12px;color:#4a5058;word-break:break-all;';
    (lines || []).forEach((ln) => {
      const p = document.createElement('div');
      p.textContent = ln;
      body.appendChild(p);
    });
    (links || []).forEach((lk) => {
      const a = document.createElement('a');
      a.href = lk.href;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = lk.text;
      a.style.cssText = 'display:inline-block;margin-top:8px;margin-right:12px;color:#2d6cdf;font-weight:600;';
      body.appendChild(a);
    });

    host.appendChild(head);
    host.appendChild(body);
    (document.body || document.documentElement).appendChild(host);
    if (timeout !== 0) setTimeout(() => host.remove(), timeout || 25000);
    return host;
  }

  // HTML 属性转义（用于把已有 key 回填到 input value）
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- 悬浮按钮（悬浮直接展开设置面板，点空白处收起） ----------
  function ensureButton() {
    if (document.getElementById('sps-fab')) return;

    const wrap = document.createElement('div');
    wrap.id = 'sps-fab';
    wrap.setAttribute('data-sps-ui', '1'); // 打标：克隆快照时剔除，避免污染产物
    wrap.style.cssText = `
      position: fixed; z-index: 2147483647; right: 24px; bottom: 24px;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    `;

    // 设置面板：绝对定位在按钮上方，悬浮即展开
    const panel = buildSettingsPanel();

    const inner = document.createElement('div');
    inner.style.cssText = 'display: flex; flex-direction: column; align-items: flex-end; gap: 10px;';

    // 主按钮（默认动作：存档）
    const fab = document.createElement('div');
    fab.id = 'sps-fab-main'; // doSave 通过它刷新进度文案
    fab.textContent = '存档本页';
    fab.style.cssText = `
      background: #2d6cdf; color: #fff; font: 600 14px/1 system-ui, sans-serif;
      padding: 12px 16px; border-radius: 24px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); user-select: none;
      white-space: nowrap;
    `;
    fab.title = '把当前页（含登录后内容）打包成自包含 HTML；鼠标悬浮可展开设置（点页面空白处收起）';
    let busy = false;
    fab.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      hideNow(); // 存档前收起面板，免得挡住右下角的 toast
      fab.textContent = '存档中…';
      fab.style.pointerEvents = 'none';
      try {
        await doSave();
      } finally {
        busy = false;
        fab.textContent = '存档本页';
        fab.style.pointerEvents = '';
      }
    });

    // 悬浮展开 / 移开收起 / 点页面空白处立即收起
    let hideTimer = null;
    const show = () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      panel.el.style.display = 'block';
    };
    const scheduleHide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hideNow, 260);
    };
    function hideNow() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      panel.el.style.display = 'none';
    }

    wrap.addEventListener('mouseenter', show);
    wrap.addEventListener('mouseleave', scheduleHide);
    // 面板是绝对定位在 wrap 之外的，鼠标在上面时 wrap 的 mouseleave 不会触发（子树内），
    // 但初始 display:none 时不响应事件，展开后单独监听更稳妥
    panel.el.addEventListener('mouseenter', show);
    panel.el.addEventListener('mouseleave', scheduleHide);

    // 点击页面空白处收起。用 capture 阶段，页面元素 stopPropagation 也拦不住。
    document.addEventListener('click', (e) => {
      if (panel.el.style.display === 'none') return;
      if (wrap.contains(e.target)) return; // 面板/按钮内的点击不管
      hideNow();
    }, true);

    inner.appendChild(panel.el);
    inner.appendChild(fab);
    wrap.appendChild(inner);
    (document.body || document.documentElement).appendChild(wrap);
  }

  // ---------- 核心保存动作：构建 → 上传 archive.org（失败降级为本地下载） ----------
  async function doSave() {
    let html, filename, redacted = 0;
    try {
      ({ html, filename, redacted } = await buildSnapshot());
    } catch (e) {
      log('构建失败', e);
      alert(`[${TOOL_NAME}] 构建快照失败：` + e.message);
      return;
    }

    // 内联失败提示：这些外链资源本地打开能靠浏览器直连显示，但 WARC 回放会成坏图
    const inlineWarn = () => (inlineFailures.length
      ? [`⚠ ${inlineFailures.length} 个资源没能内联（图床不给 CORS / 需登录），快照里留的是外链：本地打开正常，但 WARC 回放时会显示成坏图。`]
      : []);
    // 打码结果提示：开启但零命中往往是站点改版导致选择器失效，必须说出来，不能静默
    const redactNote = () => (redacted
      ? [`已按标注打码 ${redacted} 处隐私区域。`]
      : (getRedactEnabled() ? ['⚠ 已开启打码，但本页没有命中任何标注区域（站点改版后选择器可能已失效，可重新标注）。'] : []));

    // ① 仅下载模式（默认）—— 直接本地下载，不上传
    if (getDownloadOnly()) {
      log('当前模式：仅下载（不触发上传）');
      setLastResult('仅下载（未上传）' + (redacted ? `，打码 ${redacted} 处` : '')
        + (inlineFailures.length ? `，${inlineFailures.length} 个资源未内联` : ''));
      downloadSnapshot(html, filename);
      showResultToast('info', '快照已保存到下载目录',
        ['当前为「仅下载」模式，未上传 archive.org。'].concat(redactNote(), inlineWarn()), null, 12000);
      return;
    }

    // ② 未配置 key —— 这是配置矛盾（关了仅下载却没 key），必须显式暴露
    if (!hasIaKeys()) {
      setLastResult('失败：未配置 S3 key');
      showResultToast('err', '未配置 archive.org S3 Key', [
        '已关闭「仅下载」，但还没填 S3 key，本次只下载了本地快照。',
        'Key 免费申请：https://archive.org/account/s3.php',
      ], [{ text: '去申请 Key', href: 'https://archive.org/account/s3.php' }], 0);
      downloadSnapshot(html, filename);
      return;
    }

    log('当前模式：存档并上传 archive.org');

    // ③ 已配置 key 且未开仅下载 → 打包成 WARC 上传（让 archive.org 按网页归档处理）
    const identifier = makeIdentifier();
    const setFab = (t) => {
      const f = document.getElementById('sps-fab-main');
      if (f) f.textContent = t;
    };

    // 3a) 整页分片截图（可选，失败不影响 WARC 上传）
    let shots = [];
    if (getShots()) {
      setFab('截图中…');
      shots = await captureSlices(html);
    } else {
      log('已关闭截图，只上传 WARC');
    }

    // 3b) WARC 打包
    const remoteName = `snapshot_${timestamp()}.warc`;
    let warcText;
    try {
      const warcDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      warcText = await buildWarc(html, location.href, warcDate);
      log('WARC 打包完成，大小', (new Blob([warcText]).size / 1024 / 1024).toFixed(2), 'MB');
    } catch (e) {
      log('WARC 打包失败，回退上传单 HTML:', e);
      warcText = null;
    }
    const useWarc = Boolean(warcText);
    const body = useWarc ? warcText : html;
    const ct = useWarc ? 'application/warc' : 'text/html; charset=utf-8';
    const upName = useWarc ? remoteName : `snapshot_${timestamp()}.html`;

    // 3c) mediatype：有截图才设 image —— 详情页才有 BookReader 图片预览；
    //     没截图时设 web（语义正确，虽然详情页仍是 "No Preview Available"）。
    const mediatype = shots.length ? IA_MEDIATYPE_IMAGE : IA_MEDIATYPE_WEB;
    // description 优先用原页自己的摘要（SEO：item 详情页被收录时能直接对上原主题）；
    // 原页没写 meta description 时才退回工具署名句。非 ASCII 由 metaVal 统一 uri() 编码。
    const pageDesc = readPageDescription();
    const desc = pageDesc || (shots.length
      ? `Archived with ${TOOL_NAME} - WARC 1.1 + ${shots.length} full-page screenshots. Tool: ${TOOL_URL} | Original page: ${location.href}`
      : `Archived with ${TOOL_NAME} - WARC 1.1. Tool: ${TOOL_URL} | Original page: ${location.href}`);

    log('开始上传，identifier=', identifier, 'file=', upName, 'type=', ct, 'mediatype=', mediatype);
    setFab('上传中…');
    const up = await uploadWithRetry(identifier, upName, body, ct, { mediatype, description: desc, isWarc: useWarc });

    if (up.ok) {
      // 3d) 追加截图到同一个 item。WARC 已经成功，这里失败不推翻整体结果。
      let shotOk = 0;
      for (let i = 0; i < shots.length; i++) {
        const sn = `shot_${String(i + 1).padStart(3, '0')}.jpg`;
        setFab(`上传截图 ${i + 1}/${shots.length}…`);
        const r = await uploadWithRetry(identifier, sn, shots[i], 'image/jpeg', {
          mediatype, description: desc, skipVerify: true,
        });
        if (r.ok) shotOk++;
        else log('截图上传失败：', sn, r.error);
      }

      const keep = getKeepLocal();
      const lines = ['item：' + up.url];
      if (up.note) lines.push(up.note);
      lines.push(...redactNote());
      lines.push(...inlineWarn());
      if (shots.length) {
        lines.push(shotOk === shots.length
          ? `已上传 ${shotOk} 张整页截图，详情页可直接翻页预览。`
          : `截图只传上去 ${shotOk}/${shots.length} 张，预览可能不完整。`);
        lines.push('图片预览要等 archive.org 派生完成（几十秒~几分钟），稍等再刷新详情页。');
      } else {
        lines.push('（本次没有截图，详情页仍会显示 "No Preview Available"，请用在线回放）');
      }
      lines.push(keep ? '已同时下载一份本地快照。' : '（未下载本地副本，需要可在设置里打开）');

      setLastResult(
        '成功' + (up.verified ? '（响应码异常，已由 metadata 复验确认）' : '') +
          (shots.length ? `，截图 ${shotOk}/${shots.length}` : '') +
          (redacted ? `，打码 ${redacted} 处` : '') + '：' + up.url
      );

      const links = [];
      if (up.viewUrl) links.push({ text: '📖 在线回放（保真）', href: up.viewUrl });
      if (shotOk) links.push({ text: '🖼 图片预览', href: up.url });
      links.push({ text: 'item 详情页', href: up.url });
      showResultToast('ok', '✓ 已存档到 archive.org', lines, links, 30000);
      if (keep) downloadSnapshot(html, filename);
      return;
    }

    // ④ 上传确实失败 → 降级下载，保住用户的数据
    log('自动上传失败，降级为本地下载:', up.error, '（已尝试复验 metadata）');
    setLastResult('失败：' + up.error);
    showResultToast('err', '上传 archive.org 失败', [
      up.error || '未知错误',
      '已改为下载本地快照，数据不会丢。',
    ].concat(redactNote()), null, 0);
    downloadSnapshot(html, filename);
  }

  // ---------- 入口 ----------
  function init() {
    // 给点延迟，避免遮挡页面刚加载时的交互
    setTimeout(ensureButton, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

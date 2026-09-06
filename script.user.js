// ==UserScript==
// @name         v2ex屏蔽器
// @namespace    http://tampermonkey.net/
// @version      2.16
// @description  支持关键词屏蔽 + 动态更新 + 开关切换不刷新 + Base64 内容自动解码 + 回复框编辑/预览 + 图片粘贴上传
// @author       YourName
// @match        *://*.v2ex.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @updateURL    https://raw.githubusercontent.com/netcaty/dotfiles/main/script.meta.js
// @downloadURL  https://raw.githubusercontent.com/netcaty/dotfiles/main/script.user.js
// ==/UserScript==

(function() {
    'use strict';


    // 默认配置
    const defaultConfig = {
        keywords: ['结婚', '彩礼', '婚礼'],
        blockMode: 'hide',
        enabled: true,
        decodeBase64: true,
        // 从标题链接向上查找的行容器：首页是 div.cell.item，节点页（/go/xxx）是 div.cell.from_xxx.t_xxx，
        // 统一用 div.cell 两边都命中（closest 只会命中标题所在的行，不会误伤页头/分页等 cell）
        titleSelector: 'div.cell',
        rowSelector: 'span.item_title a',
        imgurClientId: ''
    };

    // 当前版本号（显示在设置面板标题旁，便于确认更新是否生效）
    const SCRIPT_VERSION = '2.16';

    // 存储兼容层：Userscripts（iOS Safari）只提供异步的 GM.getValue/GM.setValue，
    // 不支持同步 GM_getValue/GM_setValue，该环境下回落到 localStorage
    function gmGet(key, def) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, def);
        } catch (e) {}
        try {
            const raw = localStorage.getItem('v2ex-blocker.' + key);
            return raw === null ? def : JSON.parse(raw);
        } catch (e) {
            return def;
        }
    }

    function gmSet(key, val) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, val);
                return;
            }
        } catch (e) {}
        try {
            localStorage.setItem('v2ex-blocker.' + key, JSON.stringify(val));
        } catch (e) {}
    }

    // 读取配置
    const config = {
        keywords: gmGet('keywords', defaultConfig.keywords),
        blockMode: gmGet('blockMode', defaultConfig.blockMode),
        enabled: gmGet('enabled', defaultConfig.enabled),
        titleSelector: gmGet('titleSelector', defaultConfig.titleSelector),
        rowSelector: gmGet('rowSelector', defaultConfig.rowSelector),
        decodeBase64: gmGet('decodeBase64', defaultConfig.decodeBase64),
        imgurClientId: (gmGet('imgurClientId', defaultConfig.imgurClientId) || '').trim()
    };

    // 创建悬浮图标
    function createTriggerIcon() {
        const icon = document.createElement('div');
        icon.id = 'content-blocker-icon';
        icon.title = '点击配置屏蔽规则';
        icon.style = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 32px;
            height: 32px;
            background: #4CAF50;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 9998;
            font-size: 18px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
            user-select: none;
            transition: transform 0.2s;
        `;
        icon.innerHTML = '⚙️';
        document.body.appendChild(icon);

        // 添加点击事件
        icon.addEventListener('click', () => {
            toggleSettingsPanel();
            icon.style.transform = document.getElementById('content-blocker-panel').style.display === 'block'
                ? 'scale(1.1)'
                : 'scale(1)';
        });

        return icon;
    }

    // 创建配置面板（默认隐藏）
    function createSettingsPanel() {
        const panel = document.createElement('div');
        panel.id = 'content-blocker-panel';
        panel.style = `
            position: fixed;
            top: 60px;
            right: 20px;
            background: white;
            border: 1px solid #ccc;
            border-radius: 8px;
            padding: 15px;
            z-index: 9997;
            font-family: Arial, sans-serif;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            max-width: 300px;
            display: none; /* 默认隐藏 */
        `;

        panel.innerHTML = `
            <h3 style="margin-top:0;">内容屏蔽设置 <span style="font-size:12px;font-weight:normal;color:#888;">v${SCRIPT_VERSION}</span></h3>

            <div style="margin-bottom:10px;">
                <label>
                    <input id="enable-toggle" type="checkbox" ${config.enabled ? 'checked' : ''}>
                    启用屏蔽
                </label>
            </div>

            <div>
                <label>关键词列表：</label>
                <div id="keyword-list" style="margin:5px 0;"></div>
                <div style="display:flex;gap:5px;">
                    <input id="new-keyword" type="text" placeholder="输入新关键词"
                           style="flex:1;padding:5px;font-size:14px;">
                    <button id="add-keyword" style="padding:5px 10px;">添加</button>
                </div>
            </div>

            <div style="margin-top:10px;">
                <label>屏蔽方式：
                    <select id="block-mode" style="width:100%;margin-top:5px;">
                        <option value="hide" ${config.blockMode === 'hide' ? 'selected' : ''}>隐藏</option>
                        <option value="remove" ${config.blockMode === 'remove' ? 'selected' : ''}>移除</option>
                        <option value="blur" ${config.blockMode === 'blur' ? 'selected' : ''}>模糊</option>
                    </select>
                </label>
            </div>

            <div style="margin-top:10px;">
                <label>
                    <input id="base64-toggle" type="checkbox" ${config.decodeBase64 ? 'checked' : ''}>
                    自动解码 Base64 内容
                </label>
            </div>

            <button id="save-settings" style="margin-top:15px;width:100%;padding:8px;">
                保存设置
            </button>

            <div style="margin-top:10px;border-top:1px solid #eee;padding-top:10px;">
                <label>Imgur Client-ID（回复框粘贴图片自动上传）：
                    <input id="imgur-client-id" type="text" placeholder="免费注册 api.imgur.com 应用后填入"
                           style="width:100%;margin-top:5px;padding:5px;font-size:13px;box-sizing:border-box;">
                </label>
            </div>
        `;

        document.body.appendChild(panel);

        // 初始化关键词列表
        updateKeywordList();

        // 事件绑定
        document.getElementById('add-keyword').addEventListener('click', addKeyword);
        document.getElementById('save-settings').addEventListener('click', saveSettings);
        document.getElementById('new-keyword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addKeyword();
        });

        // 启用/禁用开关（不刷新页面；关闭时还原已屏蔽内容，开启时重新屏蔽）
        document.getElementById('enable-toggle').addEventListener('change', (e) => {
            config.enabled = e.target.checked;
            gmSet('enabled', config.enabled);
            if (config.enabled) {
                initBlocker();
            } else {
                restoreBlockedItems();
            }
        });

        // Base64 解码开关（不刷新页面，直接生效；关闭时还原原文）
        document.getElementById('base64-toggle').addEventListener('change', (e) => {
            config.decodeBase64 = e.target.checked;
            gmSet('decodeBase64', config.decodeBase64);
            toggleBase64Decode();
        });

        // Imgur Client-ID（失焦即保存）
        const imgurInput = document.getElementById('imgur-client-id');
        imgurInput.value = config.imgurClientId;
        imgurInput.addEventListener('change', () => {
            config.imgurClientId = imgurInput.value.trim();
            gmSet('imgurClientId', config.imgurClientId);
        });

        return panel;
    }

    // 切换面板显示状态
    function toggleSettingsPanel() {
        const panel = document.getElementById('content-blocker-panel');
        panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    }

    // 点击外部区域隐藏面板
    document.addEventListener('click', function (e) {
        const panel = document.getElementById('content-blocker-panel');
        const icon = document.getElementById('content-blocker-icon');

        // 如果面板不存在或未显示，直接返回
        if (!panel || panel.style.display !== 'block') return;

        // 点击目标不在面板或图标上时隐藏面板
        if (!panel.contains(e.target) && !icon?.contains(e.target)) {
            panel.style.display = 'none';
        }
    });

    // 更新关键词列表
    function updateKeywordList() {
        const container = document.getElementById('keyword-list');
        container.innerHTML = '';

        config.keywords.forEach((keyword, index) => {
            const div = document.createElement('div');
            div.style = "display:flex;justify-content:space-between;margin:2px 0;";
            div.innerHTML = `
                <span>${keyword}</span>

                <button class="delete-btn" data-index="${index}"
                        style="font-size:12px;padding:2px 5px;">删除</button>
            `;
            container.appendChild(div);
        });

        // 事件委托：统一处理删除按钮点击（仅绑定一次，避免重复监听导致一次误删多个关键词）
        if (!container.dataset.listenerBound) {
            container.dataset.listenerBound = '1';
            container.addEventListener('click', function (e) {
                if (e.target.classList.contains('delete-btn')) {
                    e.stopPropagation(); // 阻止事件冒泡
                    const index = parseInt(e.target.getAttribute('data-index'));
                    removeKeyword(index);
                }
            });
        }
    }

    // 删除关键词
    function removeKeyword(index) {
        if (index >= 0 && index < config.keywords.length) {
            config.keywords.splice(index, 1);
            gmSet('keywords', config.keywords);
            updateKeywordList(); // 刷新关键词列表
            initBlocker(); // 立即应用新的屏蔽规则
        }
    }

    // 添加关键词
    function addKeyword() {
        const input = document.getElementById('new-keyword');
        const keyword = input.value.trim();
        if (keyword && !config.keywords.includes(keyword)) {
            config.keywords.push(keyword);
            gmSet('keywords', config.keywords);
            updateKeywordList();
            input.value = '';
            initBlocker(); // 立即应用新的屏蔽规则
        }
    }

    // 保存设置
    function saveSettings() {
        config.blockMode = document.getElementById('block-mode').value;
        gmSet('blockMode', config.blockMode);

        location.reload(); // 保存后直接刷新页面

    }

    // 主屏蔽逻辑
    function initBlocker() {
        if (!config.enabled) return;

        if (!config.keywords.length) return;

        const lowerCaseKeywords = config.keywords.map(k => k.toLowerCase());

        //const pattern = new RegExp(config.keywords.join('|'), 'i');

            /**
         * 以标题链接为锚点遍历所有帖子，再向上定位行容器。
         * 节点页（/go/xxx）的行容器没有 item class，不能按容器正向查找，
         * 统一从 rowSelector 反查 titleSelector，两种页面通用。
         */
        const titleLinks = document.querySelectorAll(config.rowSelector);

        titleLinks.forEach(link => {
            const item = link.closest(config.titleSelector);
            if (!item) return;

            const title = link.innerText.toLowerCase(); // 获取标题文本并转为小写

            // 检查标题是否包含任何一个需要屏蔽的关键词
            const shouldBlock = lowerCaseKeywords.some(keyword => title.includes(keyword));

            if (shouldBlock) {
                // 如果包含，则隐藏整个帖子项
                applyBlockStyle(item, config.blockMode);
                console.log(`已屏蔽: ${link.href}`);
            }
        });
    }

    // 查找最近的匹配父元素
    function findClosestElement(element, selector) {
        let current = element;
        while (current && current !== document.body) {
            if (current.matches?.(selector)) return current;
            current = current.parentNode;
        }
        return null;
    }

    // 已屏蔽元素（hide/blur 模式）与已移除元素（remove 模式暂存），关闭开关时用于还原
    const blockedItems = new Set();
    const removedItems = [];

    // 应用屏蔽样式
    function applyBlockStyle(element, mode) {
        switch(mode) {
            case 'remove':
                // 先暂存节点，关闭屏蔽时能还原
                removedItems.push({
                    parent: element.parentNode,
                    nextSibling: element.nextSibling,
                    node: element
                });
                element.remove();
                break;
            case 'blur':
                blockedItems.add(element);
                element.style.filter = 'blur(5px)';
                break;
            case 'hide':
            default:
                blockedItems.add(element);
                element.style.display = 'none';
        }
    }

    // 还原所有被屏蔽的内容（关闭屏蔽开关时调用）
    function restoreBlockedItems() {
        blockedItems.forEach(el => {
            el.style.display = '';
            el.style.filter = '';
        });
        blockedItems.clear();
        while (removedItems.length) {
            const { parent, nextSibling, node } = removedItems.pop();
            if (parent && parent.isConnected) {
                parent.insertBefore(node, nextSibling);
            }
        }
    }

    // ==================== Base64 内容自动解码 ====================

    // 跳过这些标签内的文本（脚本、代码块、输入框等）
    const SKIP_BASE64_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);

    // Base64 识别：支持标准 base64 及 URL-safe 变体（- / _）
    // 最少 6 个 base64 字符（+ 最多 2 位 padding），可覆盖 "dGVzdA==" 这类短编码
    // 前后加边界：base64 片段前后不应紧贴其它 base64 字符
    // 前边界用捕获组实现而非 lookbehind（iOS Safari 16.4 以下不支持 lookbehind）
    const BASE64_BODY = 'A-Za-z0-9+/_-';
    const BASE64_CLS = `[${BASE64_BODY}]`;
    const BASE64_TOKEN_RE = new RegExp(`(^|[^${BASE64_BODY}])(${BASE64_CLS}{6,}={0,2})(?!${BASE64_CLS})`, 'g');
    const BASE64_QUICK_RE = new RegExp(`${BASE64_CLS}{6,}={0,2}`);
    const BASE64_MAX_LEN = 1024;

    // 记录被解码文本节点的原始内容，用于关闭开关时还原
    const base64OriginalText = new WeakMap();

    // 尝试解码一个 base64 片段；失败或解码结果不可读时返回 null
    function decodeBase64Text(token) {
        const len = token.length;
        if (len < 6 || len > BASE64_MAX_LEN) return null;

        // 补齐 padding，并把 URL-safe 字符转回标准 base64
        let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
        const rem = len % 4;
        if (rem === 1) return null;           // 长度非法
        if (rem === 2) b64 += '==';
        else if (rem === 3) b64 += '=';

        let binary;
        try {
            binary = atob(b64);
        } catch (e) {
            return null;
        }

        // 必须是合法 UTF-8，否则视为乱码/二进制内容，不处理
        let decoded;
        try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(
                Uint8Array.from(binary, c => c.charCodeAt(0))
            );
        } catch (e) {
            return null;
        }

        // 过滤控制字符，且解码结果至少含 2 个字母/数字/汉字，避免误替换
        let alphaCount = 0;
        for (let i = 0; i < decoded.length; i++) {
            const code = decoded.charCodeAt(i);
            if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
            if (code === 127) return null;
            if (/[a-zA-Z0-9\u4e00-\u9fa5]/.test(decoded[i])) alphaCount++;
        }
        if (alphaCount < 2) return null;

        // ===== 误判防护：避免把普通英文单词误当成 base64 =====
        // 1) 纯小写字母的 token 不可能是真实 base64（真实编码几乎总会混入大写字母/数字）
        if (/^[a-z]+$/.test(token)) return null;
        // 2) 解码结果是 token 自身的前缀（如 Facebook -> Facebo），说明只是普通单词而非编码内容
        if (token.startsWith(decoded)) return null;

        return decoded;
    }

    // 获取 root 下需要处理的所有文本节点
    function getTextNodesWithin(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (SKIP_BASE64_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
                if (parent.id === 'content-blocker-panel' || parent.id === 'content-blocker-icon') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);
        return nodes;
    }

    // 处理单个文本节点：把其中的 base64 片段替换为解码后的原文
    function decodeTextNode(node) {
        const text = node.nodeValue;
        if (!text || text.length < 6) return;
        if (!BASE64_QUICK_RE.test(text)) return;

        // 匹配结果 = 前导字符(组1) + base64 片段(组2)，还原时需带上前导字符
        const newText = text.replace(BASE64_TOKEN_RE, (match, pre, token) => {
            const decoded = decodeBase64Text(token);
            if (decoded !== null) {
                console.log('Base64 解码:', token, '→', decoded);
                return pre + decoded;
            }
            return match;
        });

        if (newText !== text) {
            const record = base64OriginalText.get(node);
            if (record) {
                record.out = newText; // 页面文本被改动过，只更新解码结果
            } else {
                base64OriginalText.set(node, { orig: text, out: newText });
            }
            // 以纯文本方式写入，不会产生 HTML 注入
            node.nodeValue = newText;
        }
    }

    // 开启：全量扫描解码；关闭：把之前解码过的节点还原为原文
    function toggleBase64Decode() {
        if (config.decodeBase64) {
            getTextNodesWithin(document.body).forEach(decodeTextNode);
        } else {
            getTextNodesWithin(document.body).forEach((node) => {
                const record = base64OriginalText.get(node);
                if (record && node.nodeValue === record.out && node.nodeValue !== record.orig) {
                    node.nodeValue = record.orig;
                }
            });
        }
    }

    // 统一处理 DOM 变化（关键词屏蔽 + base64 解码）
    function onDomChange(mutations) {
        if (config.enabled) initBlocker();
        ensureReplyPreview();
        if (!config.decodeBase64) return;

        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    decodeTextNode(node);
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    getTextNodesWithin(node).forEach(decodeTextNode);
                }
            });
        });
    }

    // ==================== 回复框增强：编辑/预览 ====================

    // V2EX 常用格式的近似渲染（链接、图片、@会员、/t/ 主题、行内代码、代码块、引用、加粗/斜体/删除线）。
    // 预览仅供参考，提交后的最终渲染以 V2EX 服务端为准。
    function renderPreview(raw) {
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const store = [];
        const stash = html => { store.push(html); return `\x00${store.length - 1}\x00`; };

        // 代码块先摘出，内部内容只做转义，不参与后续渲染
        let text = raw.replace(/```[\s\S]*?```/g, m => stash(
            `<pre style="margin:6px 0;padding:8px;background:#f8f8f8;border:1px solid #ddd;border-radius:3px;overflow-x:auto;">` +
            `<code style="font-size:13px;">${esc(m.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, ''))}</code></pre>`
        ));
        text = esc(text);

        const IMG_RE = /^https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s"'<>]*)?$/i;

        const renderLine = line => {
            // 行内代码先摘出，内部不再转链接
            line = line.replace(/`([^`]+)`/g, (m, c) => stash(
                `<code style="background:#f3f3f3;border-radius:3px;padding:1px 4px;font-size:13px;">${c}</code>`
            ));
            // URL → 图片 / 链接（尾部标点不算链接的一部分）
            line = line.replace(/https?:\/\/[^\s"'<>]+/g, url => {
                const tail = url.match(/[.,;:!?)\]}'"，。；！？：）」』]+$/);
                let main = url, after = '';
                if (tail) { after = tail[0]; main = url.slice(0, url.length - after.length); }
                const inner = IMG_RE.test(main)
                    ? stash(`<img src="${main}" style="max-width:100%;border-radius:3px;" loading="lazy">`)
                    : stash(`<a href="${main}" target="_blank" rel="noopener">${main}</a>`);
                return inner + after;
            });
            // 站内主题链接 /t/123456（可带 #回复 锚点）
            line = line.replace(/(^|[\s(])(\/t\/\d+(?:#\w+)?)/g, (m, pre, path) =>
                pre + stash(`<a href="${path}">${path}</a>`));
            // @会员（要求 @ 前是行首或空白，避免误伤邮箱）
            line = line.replace(/(^|\s)@([a-zA-Z0-9_-]+)/g, (m, pre, u) =>
                pre + stash(`<a href="/member/${u}">@${u}</a>`));
            // 加粗 / 斜体 / 删除线
            line = line.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
            line = line.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
            line = line.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
            return line;
        };

        // 逐行渲染，连续的 > 行合并为一个引用块
        const outLines = [];
        let inQuote = false;
        text.split('\n').forEach(rawLine => {
            const line = renderLine(rawLine);
            if (/^&gt;\s?/.test(line)) {
                if (!inQuote) {
                    outLines.push('<blockquote style="margin:6px 0;padding:4px 10px;border-left:3px solid #ccc;color:#666;">');
                    inQuote = true;
                }
                outLines.push(line.replace(/^&gt;\s?/, '') + '<br>');
            } else {
                if (inQuote) { outLines.push('</blockquote>'); inQuote = false; }
                outLines.push(line + '<br>');
            }
        });
        if (inQuote) outLines.push('</blockquote>');

        // 还原占位块；独立成行的块不吃 <br>
        return outLines.join('').replace(/(?:<br>)?\x00(\d+)\x00(?:<br>)?/g, (m, i) => store[+i]);
    }

    // V2EX 真实回复框的 id 是 reply_content（下划线）；兼容 reply-content 以防官方改回
    const getReplyTextarea = () => document.getElementById('reply_content') ||
                                   document.getElementById('reply-content');

    function initReplyPreview() {
        const textarea = getReplyTextarea();
        if (!textarea || textarea.dataset.previewEnhanced === '1') return;
        textarea.dataset.previewEnhanced = '1';

        if (!document.getElementById('rp-style')) {
            const style = document.createElement('style');
            style.id = 'rp-style';
            style.textContent = `
                .rp-tab { cursor:pointer; margin-right:15px; padding-bottom:2px; display:inline-block;
                          border-bottom:2px solid transparent; color:#778087; user-select:none; }
                .rp-tab.rp-active { border-bottom-color:#333; color:#333; font-weight:500; }
            `;
            document.head.appendChild(style);
        }

        const tabBar = document.createElement('div');
        tabBar.id = 'rp-tab-bar';
        tabBar.style.cssText = 'margin:0 0 5px;font-size:14px;';
        tabBar.innerHTML = `
            <span class="rp-tab rp-active" data-tab="edit">编辑</span>
            <span class="rp-tab" data-tab="preview">预览</span>
            <span id="rp-upload-status" style="float:right;font-size:12px;color:#99a0a6;"></span>
        `;

        const previewBox = document.createElement('div');
        previewBox.id = 'reply-preview';
        previewBox.style.cssText = 'display:none;min-height:110px;max-height:420px;overflow:auto;' +
            'border:1px solid #e2e2e2;border-radius:3px;background:#fff;padding:12px;' +
            'font-size:14px;line-height:1.6;word-break:break-word;';
        const emptyHint = '<span style="color:#ccc;">暂无内容，回到"编辑"输入后这里会实时渲染预览。</span>';
        previewBox.innerHTML = emptyHint;

        textarea.parentNode.insertBefore(tabBar, textarea);
        textarea.parentNode.insertBefore(previewBox, textarea.nextSibling);

        let mode = 'edit';
        const setTab = next => {
            mode = next;
            const isPreview = next === 'preview';
            textarea.style.display = isPreview ? 'none' : '';
            previewBox.style.display = isPreview ? 'block' : 'none';
            tabBar.querySelectorAll('.rp-tab').forEach(t => {
                t.classList.toggle('rp-active', t.dataset.tab === next);
            });
            if (isPreview) {
                previewBox.innerHTML = renderPreview(textarea.value) || emptyHint;
            }
        };

        tabBar.addEventListener('click', e => {
            const tab = e.target.closest('.rp-tab');
            if (tab) setTab(tab.dataset.tab);
        });

        // 预览模式下实时渲染
        textarea.addEventListener('input', () => {
            if (mode === 'preview') previewBox.innerHTML = renderPreview(textarea.value) || emptyHint;
        });

        // Cmd/Ctrl + Enter 快速回复
        textarea.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                const form = textarea.closest('form');
                const btn = form ? form.querySelector('input[type="submit"], button[type="submit"]') : null;
                if (btn) btn.click();
            }
        });

        // ==================== 图片粘贴/拖放上传（Imgur） ====================
        const uploadStatusEl = tabBar.querySelector('#rp-upload-status');
        const setUploadStatus = (text, isError) => {
            uploadStatusEl.textContent = text;
            uploadStatusEl.style.color = isError ? '#d9534f' : '#99a0a6';
            if (!isError && text && text !== '上传中…') {
                setTimeout(() => { if (uploadStatusEl.textContent === text) uploadStatusEl.textContent = ''; }, 2500);
            }
        };

        let uploadSeq = 0;
        const handleImageUpload = blob => {
            const clientId = (gmGet('imgurClientId', '') || '').trim();
            if (!clientId) {
                setUploadStatus('未配置 Imgur Client-ID，请在设置面板填写', true);
                return;
            }
            // 光标处插入占位符，成功后替换为图片链接，失败则回收
            const ph = `[图片上传中…#${++uploadSeq}]`;
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? start;
            textarea.value = textarea.value.slice(0, start) + ph + textarea.value.slice(end);
            textarea.selectionStart = textarea.selectionEnd = start + ph.length;
            textarea.dispatchEvent(new Event('input'));
            setUploadStatus('上传中…');
            const fd = new FormData();
            fd.append('image', blob, 'clipboard.png');
            fetch('https://api.imgur.com/3/image', {
                method: 'POST',
                headers: { Authorization: 'Client-ID ' + clientId },
                body: fd
            }).then(res => res.json().then(json => {
                if (!res.ok || !json.success) {
                    // v3 标准错误为 { data: { error } }，imgur 网关限流错误为 { errors: [...] }
                    const v3 = json.data && json.data.error;
                    const gw = json.errors && json.errors[0];
                    const msg = (typeof v3 === 'string' && v3)
                        || (v3 && v3.message)
                        || (gw && (gw.detail || gw.status))
                        || 'HTTP ' + res.status;
                    throw new Error(msg);
                }
                return json.data.link;
            })).then(link => {
                textarea.value = textarea.value.replace(ph, link);
                const pos = textarea.value.indexOf(link) + link.length;
                textarea.selectionStart = textarea.selectionEnd = pos;
                textarea.dispatchEvent(new Event('input'));
                setUploadStatus('上传成功');
            }).catch(err => {
                textarea.value = textarea.value.replace(ph, '');
                textarea.dispatchEvent(new Event('input'));
                setUploadStatus('上传失败：' + err.message, true);
            });
        };

        // 粘贴剪贴板图片 → 自动上传；纯文本粘贴不受任何影响
        textarea.addEventListener('paste', e => {
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            let imageItem = null;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type && items[i].type.indexOf('image/') === 0) { imageItem = items[i]; break; }
            }
            if (!imageItem) return;
            e.preventDefault();
            const blob = imageItem.getAsFile();
            if (blob) handleImageUpload(blob);
        });

        // 拖放图片文件（桌面端）
        textarea.addEventListener('dragover', e => e.preventDefault());
        textarea.addEventListener('drop', e => {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || !files.length) return;
            let file = null;
            for (let i = 0; i < files.length; i++) {
                if (files[i].type && files[i].type.indexOf('image/') === 0) { file = files[i]; break; }
            }
            if (!file) return;
            e.preventDefault();
            handleImageUpload(file);
        });

        // 回复按钮旁的快捷键提示
        const form = textarea.closest('form');
        const submitBtn = form ? form.querySelector('input[type="submit"], button[type="submit"]') : null;
        if (submitBtn && !submitBtn.dataset.rpHint) {
            submitBtn.dataset.rpHint = '1';
            const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
            const hint = document.createElement('span');
            hint.style.cssText = 'margin-left:8px;color:#99a0a6;font-size:12px;vertical-align:middle;';
            hint.textContent = (isMac ? '⌘' : 'Ctrl') + ' + Enter 快速回复';
            submitBtn.parentNode.insertBefore(hint, submitBtn.nextSibling);
        }
    }

    // 回复框可能被其它脚本（如“回复框停靠”类工具）重建或挪动：
    // 在 MutationObserver 里确认标签栏仍紧贴 textarea——被挪走就跟随，被销毁就重建
    function ensureReplyPreview() {
        const textarea = getReplyTextarea();
        if (!textarea || !textarea.parentNode) return;
        const tabBar = document.getElementById('rp-tab-bar');
        const previewBox = document.getElementById('reply-preview');
        if (textarea.dataset.previewEnhanced === '1' && tabBar && previewBox &&
            tabBar.parentNode === textarea.parentNode) return;
        if (!textarea.dataset.previewEnhanced || !tabBar || !previewBox) {
            // textarea 被替换成新元素，或 UI 节点被其它脚本销毁：清掉残留后重建
            if (tabBar) tabBar.remove();
            if (previewBox) previewBox.remove();
            delete textarea.dataset.previewEnhanced;
            initReplyPreview();
            return;
        }
        // 同一个 textarea 被挪到了新位置：标签栏和预览跟随过去
        textarea.parentNode.insertBefore(tabBar, textarea);
        textarea.parentNode.insertBefore(previewBox, textarea.nextSibling);
    }

    // ==================== 初始化 ====================
    const icon = createTriggerIcon();
    const panel = createSettingsPanel();
    initBlocker();
    if (config.decodeBase64) {
        getTextNodesWithin(document.body).forEach(decodeTextNode);
    }
    initReplyPreview();

    // 监听动态内容
    const observer = new MutationObserver(onDomChange);
    observer.observe(document.body, { childList: true, subtree: true });
})();

// ==UserScript==
// @name         v2ex屏蔽器
// @namespace    http://tampermonkey.net/
// @version      2.9
// @description  支持关键词屏蔽 + 动态更新 + 开关切换不刷新 + Base64 内容自动解码
// @author       YourName
// @match        *://*.v2ex.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function() {
    'use strict';


    // 默认配置
    const defaultConfig = {
        keywords: ['结婚', '彩礼', '婚礼'],
        blockMode: 'hide',
        enabled: true,
        decodeBase64: true,
        titleSelector: 'div.cell.item',
        rowSelector: 'span.item_title a'
    };

    // 读取配置
    const config = {
        keywords: GM_getValue('keywords', defaultConfig.keywords),
        blockMode: GM_getValue('blockMode', defaultConfig.blockMode),
        enabled: GM_getValue('enabled', defaultConfig.enabled),
        titleSelector: GM_getValue('titleSelector', defaultConfig.titleSelector),
        rowSelector: GM_getValue('rowSelector', defaultConfig.rowSelector),
        decodeBase64: GM_getValue('decodeBase64', defaultConfig.decodeBase64)
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
            <h3 style="margin-top:0;">内容屏蔽设置</h3>

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
            GM_setValue('enabled', config.enabled);
            if (config.enabled) {
                initBlocker();
            } else {
                restoreBlockedItems();
            }
        });

        // Base64 解码开关（不刷新页面，直接生效；关闭时还原原文）
        document.getElementById('base64-toggle').addEventListener('change', (e) => {
            config.decodeBase64 = e.target.checked;
            GM_setValue('decodeBase64', config.decodeBase64);
            toggleBase64Decode();
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
            GM_setValue('keywords', config.keywords);
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
            GM_setValue('keywords', config.keywords);
            updateKeywordList();
            input.value = '';
            initBlocker(); // 立即应用新的屏蔽规则
        }
    }

    // 保存设置
    function saveSettings() {
        config.blockMode = document.getElementById('block-mode').value;
        GM_setValue('blockMode', config.blockMode);

        location.reload(); // 保存后直接刷新页面

    }

    // 主屏蔽逻辑
    function initBlocker() {
        if (!config.enabled) return;

        if (!config.keywords.length) return;

        const lowerCaseKeywords = config.keywords.map(k => k.toLowerCase());

        //const pattern = new RegExp(config.keywords.join('|'), 'i');

            /**
         * 获取页面上所有的帖子项
         * V2EX 的帖子项通常是 <div class="cell item">
         */
        const topicItems = document.querySelectorAll(config.titleSelector);

        /**
         * 遍历所有帖子
         */
        topicItems.forEach(item => {
            // 获取帖子标题元素
            const titleElement = item.querySelector(config.rowSelector);

            if (titleElement) {
                const title = titleElement.innerText.toLowerCase(); // 获取标题文本并转为小写

                // 检查标题是否包含任何一个需要屏蔽的关键词
                const shouldBlock = lowerCaseKeywords.some(keyword => title.includes(keyword));

                if (shouldBlock) {
                    // 如果包含，则隐藏整个帖子项
                    applyBlockStyle(item, config.blockMode);
                    console.log(`已屏蔽: ${titleElement.href}`);
                }
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
    // 前后加边界断言：base64 片段前后不应紧贴其它 base64 字符
    const BASE64_CHAR = '[A-Za-z0-9+/_-]';
    const BASE64_TOKEN_RE = new RegExp(`(?<!${BASE64_CHAR})${BASE64_CHAR}{6,}={0,2}(?!${BASE64_CHAR})`, 'g');
    const BASE64_QUICK_RE = new RegExp(`(?<!${BASE64_CHAR})${BASE64_CHAR}{6,}={0,2}(?!${BASE64_CHAR})`);
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

        const newText = text.replace(BASE64_TOKEN_RE, (token) => {
            const decoded = decodeBase64Text(token);
            if (decoded !== null) {
                console.log('Base64 解码:', token, '→', decoded);
                return decoded;
            }
            return token;
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

    // ==================== 初始化 ====================
    const icon = createTriggerIcon();
    const panel = createSettingsPanel();
    initBlocker();
    if (config.decodeBase64) {
        getTextNodesWithin(document.body).forEach(decodeTextNode);
    }

    // 监听动态内容
    const observer = new MutationObserver(onDomChange);
    observer.observe(document.body, { childList: true, subtree: true });
})();

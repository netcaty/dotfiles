// ==UserScript==
// @name         v2ex屏蔽器
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  支持关键词屏蔽 + 动态更新 + 开关切换不刷新
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
        titleSelector: 'div.cell.item',
        rowSelector: 'span.item_title a'
    };

    // 读取配置
    const config = {
        keywords: GM_getValue('keywords', defaultConfig.keywords),
        blockMode: GM_getValue('blockMode', defaultConfig.blockMode),
        enabled: GM_getValue('enabled', defaultConfig.enabled),
        titleSelector: GM_getValue('titleSelector', defaultConfig.titleSelector),
        rowSelector: GM_getValue('rowSelector', defaultConfig.rowSelector)
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

        // 启用/禁用开关
        document.getElementById('enable-toggle').addEventListener('change', (e) => {
            config.enabled = e.target.checked;
            GM_setValue('enabled', config.enabled);
            initBlocker(); // 不刷新页面，直接更新屏蔽效果
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

        // 事件委托：统一处理删除按钮点击
        container.addEventListener('click', function (e) {
            if (e.target.classList.contains('delete-btn')) {
                e.stopPropagation(); // 阻止事件冒泡
                const index = parseInt(e.target.getAttribute('data-index'));
                removeKeyword(index);
            }
        });
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

    // 应用屏蔽样式
    function applyBlockStyle(element, mode) {
        switch(mode) {
            case 'remove':
                element.remove();
                break;
            case 'blur':
                element.style.filter = 'blur(5px)';
                break;
            case 'hide':
            default:
                element.style.display = 'none';
        }
    }

    // 初始化
    const icon = createTriggerIcon();
    const panel = createSettingsPanel();
    initBlocker();

    // 监听动态内容
    const observer = new MutationObserver(initBlocker);
    observer.observe(document.body, { childList: true, subtree: true });
})();

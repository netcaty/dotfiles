// ==UserScript==
// @name         v2ex屏蔽器
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  支持动态配置的帖子屏蔽工具
// @author       YourName
// @match        *://*.v2ex.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function() {
    'use strict';

    // 默认配置（首次运行时初始化）
    const defaultConfig = {
        keywords: ['结婚', '彩礼', '婚礼'],
        blockMode: 'hide',
        titleSelector: 'span.item_title',
        rowSelector: 'tr'
    };

    // 初始化配置存储
    const config = {
        keywords: GM_getValue('keywords', defaultConfig.keywords),
        blockMode: GM_getValue('blockMode', defaultConfig.blockMode),
        titleSelector: GM_getValue('titleSelector', defaultConfig.titleSelector),
        rowSelector: GM_getValue('rowSelector', defaultConfig.rowSelector)
    };

    // 创建配置面板
    function createSettingsPanel() {
        const panel = document.createElement('div');
        panel.id = 'content-blocker-panel';
        panel.style = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: white;
            border: 1px solid #ccc;
            border-radius: 8px;
            padding: 15px;
            z-index: 9999;
            font-family: Arial, sans-serif;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 300px;
        `;

        panel.innerHTML = `
            <h3 style="margin-top:0;">内容屏蔽设置</h3>
            
            <!-- 关键词管理 -->
            <div>
                <label>关键词列表：</label>
                <div id="keyword-list" style="margin:5px 0;"></div>
                <div style="display:flex;gap:5px;">
                    <input id="new-keyword" type="text" placeholder="输入新关键词" 
                           style="flex:1;padding:5px;font-size:14px;">
                    <button id="add-keyword" style="padding:5px 10px;">添加</button>
                </div>
            </div>

            <!-- 屏蔽模式选择 -->
            <div style="margin-top:10px;">
                <label>屏蔽方式：
                    <select id="block-mode" style="width:100%;margin-top:5px;">
                        <option value="hide">隐藏</option>
                        <option value="remove">移除</option>
                        <option value="blur">模糊</option>
                    </select>
                </label>
            </div>

            <!-- 保存按钮 -->
            <button id="save-settings" style="margin-top:15px;width:100%;padding:8px;">
                保存设置
            </button>
        `;

        document.body.appendChild(panel);
        updateKeywordList();

        // 事件绑定
        document.getElementById('add-keyword').addEventListener('click', addKeyword);
        document.getElementById('save-settings').addEventListener('click', saveSettings);
        document.getElementById('new-keyword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addKeyword();
        });

        return panel;
    }

    // 更新关键词列表显示
    function updateKeywordList() {
        const container = document.getElementById('keyword-list');
        container.innerHTML = '';
        
        config.keywords.forEach((keyword, index) => {
            const div = document.createElement('div');
            div.style = "display:flex;justify-content:space-between;margin:2px 0;";
            div.innerHTML = `
                <span>${keyword}</span>
                <button onclick="removeKeyword(${index})" style="font-size:12px;padding:2px 5px;">删除</button>
            `;
            container.appendChild(div);
        });
    }

    // 添加新关键词
    function addKeyword() {
        const input = document.getElementById('new-keyword');
        const keyword = input.value.trim();
        if (keyword && !config.keywords.includes(keyword)) {
            config.keywords.push(keyword);
            updateKeywordList();
            input.value = '';
        }
    }

    // 删除关键词（全局暴露方法）
    window.removeKeyword = function(index) {
        config.keywords.splice(index, 1);
        updateKeywordList();
    }

    // 保存设置
    function saveSettings() {
        config.blockMode = document.getElementById('block-mode').value;
        GM_setValue('blockMode', config.blockMode);
        GM_setValue('keywords', config.keywords);
        alert('设置已保存，页面将在3秒后刷新');
        setTimeout(() => location.reload(), 3000);
    }

    // 主屏蔽逻辑
    function initBlocker() {
        if (!config.keywords.length) return;

        // 构建正则表达式
        const pattern = new RegExp(config.keywords.join('|'), 'i');
        
        // 查找所有标题元素
        document.querySelectorAll(config.titleSelector).forEach(titleElement => {
            const text = titleElement.textContent.trim();
            
            if (pattern.test(text)) {
                // 查找最近的行元素
                const row = findClosestElement(titleElement, config.rowSelector);
                if (row) {
                    applyBlockStyle(row, config.blockMode);
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

    // 初始化配置面板
    createSettingsPanel();

    // 初始执行
    initBlocker();

    // 监听动态内容变化
    const observer = new MutationObserver(initBlocker);
    observer.observe(document.body, { childList: true, subtree: true });
})();

// ==UserScript==
// @name         v2ex帖子屏蔽专家
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  精准匹配 item_title 内容，屏蔽整行帖子
// @author       YourName
// @match        *://*.v2ex.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 配置区域
    const config = {
        keywords: ['结婚', '彩礼', '婚礼'], // 屏蔽关键词
        titleSelector: 'span.item_title',   // 标题选择器
        blockMode: 'hide'                   // hide/remove/blur
    };

    // 获取父级 tr 元素
    function findParentTR(element) {
        let current = element;
        while (current && current.tagName !== 'TR') {
            current = current.parentNode;
        }
        return current;
    }

    // 初始化屏蔽
    function init() {
        document.querySelectorAll(config.titleSelector).forEach(titleElement => {
            const text = titleElement.textContent.trim();
            const regex = new RegExp(config.keywords.join('|'), 'i'); // 不区分大小写
            
            if (regex.test(text)) {
                const tr = findParentTR(titleElement);
                if (tr) {
                    switch(config.blockMode) {
                        case 'remove':
                            tr.remove();
                            break;
                        case 'blur':
                            tr.style.filter = 'blur(5px)';
                            break;
                        default:
                            tr.style.display = 'none';
                    }
                }
            }
        });
    }

    // 监听动态内容
    const observer = new MutationObserver(init);
    observer.observe(document.body, { childList: true, subtree: true });

    // 初始执行
    init();
})();
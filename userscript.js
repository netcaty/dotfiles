// ==UserScript==
// @name         v2ex屏蔽器
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  屏蔽包含指定关键词的网页内容（如论坛帖子）
// @author       YourName
// @match        *://*.v2ex.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 配置区域（可自定义修改）
    const config = {
        // 需要屏蔽的关键词（支持正则表达式）
        keywords: ['结婚', '彩礼', '婚礼', '嫁妆', '订婚'],
        
        // 帖子选择器（根据目标网站结构调整）
        postSelector: 'span.item_title',
        
        // 是否启用模糊匹配（true为包含任意关键词即屏蔽）
        fuzzyMatch: true,
        
        // 屏蔽方式：hide（隐藏）/remove（移除）/blur（模糊）
        blockMode: 'hide'
    };

    // 初始化屏蔽逻辑
    function init() {
        // 获取所有帖子元素
        const posts = document.querySelectorAll(config.postSelector);
        
        // 处理每个帖子
        posts.forEach(post => {
            // 获取元素文本内容
            const textContent = post.textContent || post.innerText;
            
            // 检查是否包含敏感词
            const needBlock = config.keywords.some(keyword => {
                // 模糊匹配模式：字符串包含
                if (config.fuzzyMatch) {
                    return textContent.includes(keyword);
                }
                // 精确匹配模式：正则测试
                return new RegExp(keyword).test(textContent);
            });

            // 执行屏蔽操作
            if (needBlock) {
                switch(config.blockMode) {
                    case 'remove':
                        post.remove();
                        break;
                    case 'blur':
                        post.style.filter = 'blur(2px)';
                        post.style.opacity = '0.5';
                        break;
                    default:
                        post.style.display = 'none';
                }
            }
        });
    }

    // 监听DOM变化（处理动态加载内容）
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.type === 'childList') {
                init();
            }
        });
    });

    // 启动观察器
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 初始执行
    init();
})();
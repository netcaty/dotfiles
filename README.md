# make linux great again

## 用法

```
git clone repo.git 
ln -s repo/.bash_alias .bash_alias
在你的.bashrc文件追加一行：
[ -f "$HOME/.bash_alias" ] && . "$HOME/.bash_alias"
```

winget import --import-file "winstall-9113.json" 

## 油猴脚本：v2ex屏蔽器

`v2ex-blocker.user.js` —— V2EX 增强脚本，按关键词过滤首页和节点页的帖子，
另含 Base64 内容自动解码、回复框实时预览与图片粘贴上传。

安装：Tampermonkey 中新建脚本，粘贴文件内容，或直接访问 GreasyFork 页面安装。

更新版本时必须递增脚本头部的 `@version`，GreasyFork 靠它判断是否有新版本。
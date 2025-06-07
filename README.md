# make linux great again

## 用法

`
git clone repo.git 
ln -s repo/.bash_alias .bash_alias
在你的.bashrc文件追加一行：
[ -f "$HOME/.bash_alias" ] && . "$HOME/.bash_alias"
`
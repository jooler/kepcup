# 自带二进制

按平台目录放置随应用分发的命令行工具：`{platform}-{arch}/`。

## rg（ripgrep）14.1.1

- 来源：BurntSushi/ripgrep 14.1.1 官方构建（经 npmmirror `ripgrep-prebuilt/v14.1.1-1` 分发，与上游 release 同一二进制）。
- 覆盖：darwin-arm64、darwin-x64、linux-x64、linux-arm64（Linux 为 musl 静态链接）。
- 用途：pi-coding-agent 的 grep 工具；srt 在 Linux 上展开 read-deny glob。

## bwrap / socat（Linux）

尚未随应用分发（见 docs/dev/DEVIATIONS.md DEV-003）：上游不提供可在
Ubuntu 24.04 / Debian 12 / Fedora 间通用的静态构建（Ubuntu/Debian 的
bubblewrap、socat 均动态链接 glibc，跨发行版复制不可靠）。当前在 Linux 上
通过系统 PATH 解析，缺失时沙箱探测失败并在设置页提示安装命令。

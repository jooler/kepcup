-- 组件海报：对话卡片改为静态「海报」展示（点击后在覆盖层里才真正运行），海报画面
-- 用自检（S2 预览）首视口截图。widget_versions.poster_png 存 base64 PNG，可空——
-- legacy 版本与截图失败时没有海报，前端回退图标占位。
ALTER TABLE widget_versions ADD COLUMN poster_png TEXT;

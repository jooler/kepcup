-- 微应用运行时（D112，设计 55 §4.3）：widget_versions 增清单三列，widgets 增版本双指针。
-- 存量组件 manifest_json 为空 → 按「单文件、无能力」处理，行为完全不变（55 §13.2）。

ALTER TABLE widget_versions ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '';
ALTER TABLE widget_versions ADD COLUMN bundle_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE widget_versions ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';

-- 版本双指针（55 §9.1）：NULL = 跟随卡片钉住版本（存量语义）；微应用更新后指向新版本，
-- 「升级 = 写新版本并把 next_version 指过去，不热替换运行中的实例」，重新打开生效。
ALTER TABLE widgets ADD COLUMN next_version INTEGER;

-- Bot 的强调色（accent_color，色板 id 字符串）：该 Bot 在应用各处的腔调色——
-- 预置头像填充、名字 / @ 提及、输入框发送键、看板脸、工作台执行者色、用户气泡。
-- 与头像形状、是否上传头像无关（0060 / 0061 只作用于上传图片的外观）。
-- NULL = 未显式设置：读侧回退到预置头像内嵌色、再回退 mono，旧行不回填（外观不变）。
ALTER TABLE bots ADD COLUMN accent_color TEXT;

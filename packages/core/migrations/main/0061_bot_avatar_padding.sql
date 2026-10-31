-- 上传头像的内边距（avatar_padding，像素整数）：容器尺寸不变，图片内缩后填充
-- 剩余空间，用来把自带留白不一的图片调到视觉大小一致。取值 0-16；NULL = 0
-- （旧行不需要回填，读侧按 0 兜底）。只影响 `upload:` 头像，与 0060 的
-- avatar_mask 一样独立于 Profile。
ALTER TABLE bots ADD COLUMN avatar_padding INTEGER;

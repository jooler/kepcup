-- 上传头像的遮罩形状（avatar_mask）：圆角正方形是产品新增的可选项，圆形保持默认。
-- 取值 'circle' | 'rounded'；NULL = 'circle'（旧行不需要回填，读侧按 circle 兜底）。
-- 只影响 `upload:` 头像的裁切外观：预置头像自带轮廓，首字母占位仍是圆形。
ALTER TABLE bots ADD COLUMN avatar_mask TEXT;

-- 「只属于该 Bot」机制整体移除：private_to_bot 的唯一行为效果是阻止条目进入
-- 共享画像（+ 移交排除），产品决定取消这个关闭开关——画像该影响的就影响，
-- 隐私边界由 sensitivity（敏感类别）继续承担。列按 main/0030 的先例直接删除。
ALTER TABLE memory_items DROP COLUMN private_to_bot;

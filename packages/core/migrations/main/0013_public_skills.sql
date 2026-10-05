-- P08 增量：公共技能（docs/design/05-wiki-and-skills.md「来源与作用域」）。
-- 技能市场安装为公共技能：一次安装，所有 Bot 都能发现并调用；各 Bot 的私有
-- 技能（git 导入 + 自建，bot_skills）能力不变。同名时私有遮蔽公共。

CREATE TABLE public_skills (
  name          TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES skill_library(id),
  status        TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'incompatible')),
  status_reason TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 升级：此前按 Bot 安装的预置技能（库条目 source_url = preset://...）整体
-- 转为公共技能；同名多 Bot 引用取最早一条的状态。非预置来源的私有技能不动。
INSERT INTO public_skills (name, library_id, status, status_reason, created_at, updated_at)
SELECT b.name, b.library_id, b.status, b.status_reason, MIN(b.created_at), MIN(b.updated_at)
FROM bot_skills b
JOIN skill_library l ON l.id = b.library_id
WHERE l.source_url LIKE 'preset://%'
GROUP BY b.name;

DELETE FROM bot_skills WHERE rowid IN (
  SELECT b.rowid
  FROM bot_skills b
  JOIN skill_library l ON l.id = b.library_id
  WHERE l.source_url LIKE 'preset://%'
);

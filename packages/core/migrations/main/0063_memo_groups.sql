-- 备忘分组 + 备忘/事项手动拖拽排序（docs/design/39-workbench.md §5.4）。
-- memo_groups：用户建的分组；「未分组」不是行（memos.group_id IS NULL）。
--   memos.group_id 带 ON DELETE SET NULL，服务删组时也会先显式清空，FK 只是兜底。
-- memos.position / todos.position：手动排序键（升序，placeItem 取中点）。回填按改动前的
--   显示顺序展开，所以拖动之前看到的一切不变。置顶备忘仍靠 `pinned desc` 浮在组顶；
--   改正文不移动卡片；新备忘/新事项插到所属组 / 道的顶部（取最小 position 之前）。

CREATE TABLE memo_groups (
  id          TEXT PRIMARY KEY,                                        -- mmg_...
  -- length() stops at the first NUL, so instr rejects an embedded NUL (same as board_columns).
  title       TEXT NOT NULL CHECK (
                length(title) BETWEEN 1 AND 60 AND instr(title, char(0)) = 0
              ),
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

ALTER TABLE memos ADD COLUMN group_id TEXT REFERENCES memo_groups(id) ON DELETE SET NULL;
ALTER TABLE memos ADD COLUMN position REAL NOT NULL DEFAULT 0;

-- 备忘回填：此前显示顺序 = 置顶在前，其余 sort_at 倒序（id 兜底）；
-- 第 r 名拿 r*1024，position 升序即旧显示顺序。
UPDATE memos SET position = ranked.pos
FROM (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY pinned DESC, sort_at DESC, id DESC) * 1024 AS pos
  FROM memos
) AS ranked
WHERE ranked.id = memos.id;

DROP INDEX memos_live;
CREATE INDEX memos_live ON memos(deleted_at, pinned DESC, position ASC);
CREATE INDEX memos_group ON memos(group_id);

ALTER TABLE todos ADD COLUMN position REAL NOT NULL DEFAULT 0;

-- 事项回填：道 = 未指派 → Bot → 项目组；道内 = 状态（待验收→进行中→已排期→草案），
-- 已排期按下次触发在前（schedules 表 join，无排期的排最后），其余按 updated_at 倒序。
-- 一次近似：进行中的周期事项（scheduled + 在跑 run）按 scheduled 排，不细究。
-- 与 schedules 联表后 status / id 等列名撞车，一律用 todos. 限定。
UPDATE todos SET position = ranked.pos
FROM (
  SELECT todos.id,
         ROW_NUMBER() OVER (
           ORDER BY CASE
                      WHEN todos.assignee_bot_id IS NULL AND todos.assignee_project_id IS NULL THEN 0
                      WHEN todos.assignee_bot_id IS NOT NULL THEN 1
                      ELSE 2
                    END ASC,
                    CASE todos.status
                      WHEN 'delivered' THEN 0
                      WHEN 'in_progress' THEN 1
                      WHEN 'scheduled' THEN 2
                      WHEN 'draft' THEN 3
                      WHEN 'done' THEN 4
                      ELSE 5
                    END ASC,
                    CASE WHEN todos.status = 'scheduled'
                         THEN COALESCE(s.next_fire_at, 9007199254740992)
                         ELSE 0 END ASC,
                    CASE WHEN todos.status = 'scheduled' THEN 0 ELSE todos.updated_at END DESC,
                    todos.id DESC
         ) * 1024 AS pos
  FROM todos
  LEFT JOIN schedules s ON s.todo_id = todos.id AND s.origin = 'workbench' AND s.status = 'active'
) AS ranked
WHERE ranked.id = todos.id;

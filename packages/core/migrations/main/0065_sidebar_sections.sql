-- 左栏对话分组的持久化（design/12-ui-layout.md「对话分组」）。
-- 之前存在渲染层 localStorage 键 kepcup.sidebar.sections.v1：localStorage 按 origin
-- 隔离，开发模式（dev server）与打包版（file://）各存一份，改存 main.db 后随数据目录
-- 一份，开发版 / 发行版看到的是同一套分组。
--
-- sidebar_sections：分组目录 + 显示顺序 + 折叠状态。
--   'unassigned' 是内置「未指定」组：name 为 NULL（显示名由界面本地化），不能重命名
--   或删除；其余行是用户建的分组。position 与看板 / 工作台同一套分数排序键（升序）。
-- conversation_sidebar：会话在左栏的偏好（归属 + 置顶）。
--   行只在有归属或置顶时存在；缺行 = 未指定、未置顶。
--   conversation_id 主键随会话物理删除级联清理；删分组时归属回落为 'unassigned'
--   （ON DELETE SET DEFAULT，与界面「组内对话回到未指定」一致）。
--   归档（0045）的会话保留偏好行，恢复后回到原分组。
CREATE TABLE sidebar_sections (
  id         TEXT PRIMARY KEY,                     -- sec_... 或内置 'unassigned'
  name       TEXT CHECK (
               name IS NULL
               OR (length(name) BETWEEN 1 AND 40 AND instr(name, char(0)) = 0)
             ),
  position   REAL NOT NULL,
  collapsed  INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 内置「未指定」是唯一没有名字的组；有名字的行也不能占用它的 id。
  CHECK ((id = 'unassigned') = (name IS NULL))
);

CREATE INDEX sidebar_sections_order ON sidebar_sections(position);

INSERT INTO sidebar_sections (id, name, position, collapsed, created_at, updated_at)
VALUES ('unassigned', NULL, 1024, 0, 0, 0);

CREATE TABLE conversation_sidebar (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  section_id      TEXT NOT NULL DEFAULT 'unassigned'
                    REFERENCES sidebar_sections(id) ON DELETE SET DEFAULT,
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX conversation_sidebar_section ON conversation_sidebar(section_id);

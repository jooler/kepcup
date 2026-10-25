-- Project board (D103, docs/design/50-project-board.md §5).
-- Card identity is a board_cards row; the card id is the todo id. todos gains no columns.
-- board_cards.column_id has no ON DELETE (NO ACTION): the service moves or deletes
-- cards before a column goes. Deleting a project conversation cascades both tables
-- at the end of the statement, after onProjectDeleting has purged the todos.

CREATE TABLE board_columns (
  id          TEXT PRIMARY KEY,                                        -- bcol_...
  project_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX board_columns_project ON board_columns(project_id, position);

CREATE TABLE board_cards (
  todo_id     TEXT PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE, -- card id = todo id
  project_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  column_id   TEXT NOT NULL REFERENCES board_columns(id),              -- NO ACTION
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX board_cards_column ON board_cards(column_id, position);
CREATE INDEX board_cards_project ON board_cards(project_id);

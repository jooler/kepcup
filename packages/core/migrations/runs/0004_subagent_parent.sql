-- D66 SubAgent ownership + D67 journal alignment
-- (docs/design/23-mcp-and-subagent.md, docs/design/24-durable-execution.md
-- "subagent : child_run_id + ownership"): which run delegated this sub run;
-- NULL for every non-subagent run.
ALTER TABLE runs ADD COLUMN parent_run_id TEXT;

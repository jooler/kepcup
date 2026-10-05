-- Loop 续接 (docs/design/02-execution.md "Loop 续接", D56): which runs' process
-- records were replayed into this run's context; NULL = no continuation.
ALTER TABLE runs ADD COLUMN continued_from_run_ids_json TEXT;

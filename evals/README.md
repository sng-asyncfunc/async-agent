# `async-agent` Braintrust Quality Evals

Evaluates `async-agent` end-to-end quality using [Braintrust](https://www.braintrust.dev) (`bt eval --runner bun`).

## Cases
1. `repl_state_and_closures` — persistent Bun REPL closures, unblocked variable names (`prompt`), and exact computation.
2. `oversized_spill_triage` — 120 noisy vendor records with hidden compliance blockers & schema drift (checks context hygiene + `$out_<n>` spill discipline).
3. `atomic_multi_file_edit` — multi-file TypeScript bug fix graded live by `bun test`.
4. `local_module_import_triage` — cwd-relative ESM `import` inside the Bun REPL + log aggregation.
5. `buggy_loop_debug` — infinite-loop pagination bug fix graded live by `bun test --timeout 3000`.
6. `swarm_parallel_reconcile` — 3-shard parallel `rlm.spawn()` / `rlm.collect()` reconciliation over a dedicated `aa-daemon` socket.

## Running

```bash
cd evals
bun install

# Run full suite and upload experiment to Braintrust (default: google / gemini-4-neon)
bt eval --runner bun async_agent.eval.ts

# Compare another model or thinking level
EVAL_MODEL=gemini-4-hydrogen EVAL_THINKING=low bt eval --runner bun async_agent.eval.ts

# Dry-run locally without sending logs to Braintrust
bt eval --runner bun --no-send-logs async_agent.eval.ts
```

## Environment Variables
- `BRAINTRUST_PROJECT` (default: `My Project`)
- `BRAINTRUST_EXPERIMENT` (default: `async-agent-<git-sha>-<model>`)
- `ASYNC_AGENT_BIN` (default: `async-agent`)
- `EVAL_PROVIDER` (default: `google`)
- `EVAL_MODEL` (default: `gemini-4-neon`)
- `EVAL_THINKING` (default: `low`)
- `EVAL_CONCURRENCY` (default: `2`)

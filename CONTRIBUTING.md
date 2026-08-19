# Contributing

Thanks for helping with **Context Assembler DSH（上下文汇编）**.

## Environment

- Node.js ≥ 22, pnpm ≥ 9
- `pnpm install` — install dependencies
- `pnpm build` — typecheck (`tsc --noEmit`)
- `pnpm test` — run the vitest suite (38 files, 466 tests)

## Where things live

```
lib/        plugin implementation (pure-computation Cordis plugin, no host deps)
test/       vitest suites (unit / projection / handoff / compaction / e2e)
scripts/    offline ops tools (ca-db CLI, summarize-history CA库 builder, evals)
docs/       docs/DESIGN.md (design intent & Hermes mapping) · docs/decisions/ (ADRs)
docs/images/  README diagrams — sources in docs/images/src/*.dot (graphviz)
```

## Commit discipline (project rule — keep it)

1. `git commit` the current state **before** starting an improvement.
2. One commit per improvement; the message carries the semantic id (`B1`/`P1`/`R1`…) plus intent.
3. Any behavior change must update `docs/DESIGN.md` (or the relevant module doc) in the same
   change — the docs are the single source of intent.

## Docs & diagrams

- `docs/DESIGN.md` is the authoritative design intent (goals, Hermes mapping, fixed-issue
  ledger, open roadmap R1/R2/R3). Read it before touching engine/topic/reality code.
- ADRs live in `docs/decisions/` (numbered). New decisions get a numbered ADR.
- README diagrams are rendered from `docs/images/src/*.dot`:

  ```sh
  dot -Tpng docs/images/src/pipeline.dot -o docs/images/pipeline.png
  ```

## Local 4B backfill

Optional runtime features (reality recall, tool backfill, thought assembly) default to a
local Ollama-compatible endpoint (`http://127.0.0.1:11435`) and are all **fail-open**: a
missing model or DB disables the feature, never the session. Tests mock or skip these paths.
All CA Ollama LLM calls declare queue priority per request via `X-Queue-Priority: high|normal|low`;
keep using the main proxy port `11435` for CA — the dedicated ports `11436/11438/11439/11440`
are for clients that cannot set headers (e.g. OpenViking).

## License

MIT — by contributing you agree your changes are licensed under the same terms.

---
description: Analyze confirmed Ion vocabulary changes, update the registry, and regenerate its index without renaming code.
model: standard
allowed_bash_commands: [git, graphify, grep, rg, sed, cat, node, make]
---

You are running the `/update-vocabulary` command.

**Invocation arguments.** The raw arguments passed to this invocation (referred to as **ARGS** throughout this document) are:

```
$ARGUMENTS
```

If the block above is empty, inspect changes on the current branch since the merge base with its source branch. Derive vocabulary work only from those changes. If ARGS is not empty, treat it as a concept, domain, path, or client surface and analyze that target.

Follow this procedure in order:

1. Read `docs/vocabulary/terms.json` and `docs/vocabulary/index.md`.
2. Query the code graph first with `graphify query`, `graphify explain`, or `graphify path`. If graphify is unavailable, fall through to grep and source reads without comment.
3. Confirm every candidate fact in source. Record a `file:line` citation for each fact.
4. Inspect related domains and every other client surface for the same concept.
5. Classify each finding as a new term, alias, legacy name, rename, deprecation, or no-change.
6. Update only facts confirmed in source. Never invent a term that is not present in source. Every entry must trace to a real symbol, contract, or user-visible surface.
7. Run `make generate-vocabulary`, then `make check-vocabulary`.
8. Surface unresolved decisions to the operator with a recommendation for each.

**Hard rules**

- Never rename a code symbol, contract field, wire event, or public API as part of this command. Vocabulary registry changes are documentation-layer only. Report a needed code rename as a recommendation. It requires a separate explicit operator request.
- Do not add an entry until its source fact is confirmed.

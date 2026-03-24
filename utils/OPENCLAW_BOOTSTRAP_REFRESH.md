## OpenClaw Workspace Bootstrap Refresh

### What this fixes

OpenClaw caches workspace bootstrap files per long-lived session key inside the running gateway process.
For the personal agent, that usually means `agent:personal:main`.

If you edit files like:

- `AGENTS.md`
- `TOOLS.md`
- `BOOTSTRAP.md`
- `MEMORY.md`

the running gateway may keep using the old cached versions until the cache is cleared.

### Typical symptom

- The agent keeps answering with an old format even though the workspace files were updated.
- `systemPromptReport.injectedWorkspaceFiles` shows `BOOTSTRAP.md` as `missing: true` even though the file exists.
- Output still looks like the stale pre-fix response.

### Best-practice refresh

Run:

```bash
/root/openclaw-notion-ops/utils/refresh-openclaw-bootstrap.sh
```

That script:

1. Restarts the Dockerized OpenClaw gateway container.
2. Waits for `openclaw health` to succeed again.
3. Forces the next agent turn to rebuild bootstrap context from disk.

### Why restart is the safe fix

The stale state lives in the in-memory gateway bootstrap cache, not in the workspace files themselves.
Restarting the gateway is the clean supported way to clear that state without patching OpenClaw internals.

### Operational notes

- Expect the first reply after a restart to be slower than normal.
- The `personal` main session can still be slow on large conversations; that is separate from the bootstrap-cache bug.
- For deterministic workflow behavior, prefer dedicated workflow commands over relying only on natural-language routing in a long-lived chat session.

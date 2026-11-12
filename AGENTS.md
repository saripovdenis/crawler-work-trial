# Project preferences

- Keep communication concise.
- Do not add, restore, or run automated tests unless the user explicitly requests them.
- Use type checks, builds, static boundary checks, and manual inspection for validation.
- Keep deployment backups and operational health checks.
- Never run the crawler against live sites for validation.

## Releases

- Only `master` is deployable. Merge feature work into `master` before deploying.
- Use the root-owned VM command `sudo /usr/local/sbin/deploy-exa-master [full master SHA]`.
- Never deploy from `codex/observability`, a worktree, an uploaded source archive, or an ad hoc service-file edit.
- Do not restart individual services onto different commits. The canonical command updates all four together, keeps the request ledger, checks Freshness, and serializes deployments.
- If the deployment lock is held or master advanced, wait or retry; never bypass the guard.

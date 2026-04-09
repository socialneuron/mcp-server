# Git Hooks for `@socialneuron/mcp-server`

Repo-local git hooks that enforce public-repo hygiene.

## Installation (one-time per clone)

```bash
git config core.hooksPath .githooks
```

Git will now run hooks from this directory instead of `.git/hooks/`.

## What's installed

### `pre-push`

Uses an **allowlist** model — rejects any push containing commits whose author or committer email is not on the allowlist:

- `socialneuronteam@gmail.com` (team identity — use this for all hand-written commits)
- `<id>+dependabot[bot]@users.noreply.github.com` (Dependabot)
- `<id>+github-actions[bot]@users.noreply.github.com` and `github-actions@github.com` (GitHub Actions bot)

It also rejects commit messages containing:

- `Co-Authored-By: ... Claude` or `... anthropic`
- "🤖 Generated with Claude Code" footers

**Why:** on 2026-04-08 a merge pattern (`gh pr merge --squash --admin`) silently re-authored squash commits with the authenticated gh user's personal email, leaking that email to public history. The remediation required a full force-push history rewrite. This hook blocks the class of mistake at the push boundary.

Allowlist is safer than blocklist: it catches new personal identities you haven't thought to add to a blocklist yet.

## Belt-and-braces layering

This hook is one of three layers protecting against identity leaks:

1. **GitHub account setting** — "Block command line pushes that expose my email" at <https://github.com/settings/emails>. Enforced by GitHub's push endpoint itself. Hardware-level, per-account.
2. **This pre-push hook** — enforced at the local git layer, repo-specific, catches personal emails and AI attribution. Opt-in (must run `git config core.hooksPath .githooks` once).
3. **The local-squash merge rule** — convention: NEVER use `gh pr merge --squash --admin` on public repos; always `git merge --squash` locally then `git push`.

Any one layer catches the problem. All three means it is extremely unlikely to recur.

## Adding a new allowed identity

Edit `.githooks/pre-push` and add a regex pattern to `ALLOWED_EMAIL_PATTERNS` with a comment explaining why the identity is permitted.

## Bypassing (not recommended)

```bash
git push --no-verify origin main
```

If you find yourself bypassing often, update the allowlist to match reality instead.

## Adding new hooks

Add a new file in this directory named after the git hook (`pre-commit`, `commit-msg`, etc.), make it executable (`chmod +x .githooks/<name>`), and update this README.

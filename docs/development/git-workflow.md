# Git & GitHub Workflow

## Repository

- Remote `origin`: `https://github.com/THeOGSaugat/Mero-Stay.git`
- Default branch: `main`

## Branching

```
main                    # always stable, reviewed work only
└── phase/01-scaffolding   # one branch per phase
```

1. `git switch main && git pull`
2. `git switch -c phase/XX-short-name`
3. Commit in small, meaningful steps.
4. Push the branch: `git push -u origin phase/XX-short-name`
5. After owner review: merge into `main` (via a GitHub Pull Request or fast-forward), then push `main`.

## Commit messages (Conventional Commits)

```
<type>(<scope>): <short summary>

<optional body: what and why>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`, `perf`, `style`.
Scopes: `web`, `api`, `shared`, `db`, `e2e`, `docs`, `repo`.

Examples:
- `feat(api): add property submission endpoint`
- `test(api): cover overlapping booking rejection`
- `docs: add phase 3 report`

## Before every commit

```bash
git status --short
git diff --cached --name-only
git diff --cached | grep -nEi "(api[_-]?key|secret|password|token|BEGIN (RSA|EC|OPENSSH) PRIVATE)" || echo "clean"
git check-ignore -v .env node_modules
```

Inspect any match by hand. Real secrets must never be committed. If one is committed by accident,
**rotate the secret immediately**. Removing it from history alone is not enough.

## Never

- Force-push to `main`
- Commit `.env` files, keys, `node_modules`, build output, coverage, uploads or DB dumps
- Use a Git identity other than the owner's own verified one

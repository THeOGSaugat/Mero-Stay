# Phase 00: Repository Setup & Documentation

- **Status:** Approved
- **Branch:** `main` (initial commit)
- **Date completed:** 2026-11-18

## Scope (as approved)

- Verify Git, branch, remote, identity and `.gitignore`
- Create CLAUDE.md with requirements, architecture, security, conventions and workflow
- Create the documentation structure
- No application features

## Git verification

| Check | Result |
|---|---|
| Git initialized | Yes |
| Current branch | `main` (no prior commits) |
| Remote `origin` | `https://github.com/THeOGSaugat/Mero-Stay.git` (already configured; remote repository was empty) |
| `user.name` / `user.email` | Configured globally by the owner (not changed) |
| `.gitignore` | Created; covers env files, keys, `node_modules`, build output, test artifacts, uploads, logs |

## Files created

- `CLAUDE.md`: project rules (requirements, architecture, security, conventions, workflow)
- `README.md`: project overview
- `.gitignore`, `.gitattributes`, `.editorconfig`: repository hygiene
- `docs/README.md`: documentation index
- `docs/product/requirements.md`: MVP requirements, user stories, open questions
- `docs/architecture/overview.md`: target architecture
- `docs/architecture/decisions/0000-template.md`, `0001-monorepo-with-separate-api.md`: ADRs
- `docs/development/roadmap.md`: phase plan and definition of done
- `docs/development/git-workflow.md`: branching, commits, pre-commit checks
- `docs/security/security-guidelines.md`: security practices
- `docs/design/README.md`: where design references go
- `docs/phases/_template.md`, `phase-00-setup.md`: phase reports

## Important technical decisions

- **Monorepo with npm workspaces + separate Express API** (ADR 0001). The API serves web now and mobile later.
- **Money in integer paisa, UTC timestamps, DATE stay dates.** These prevent rounding and timezone bugs (Nepal is UTC+05:45).
- **eSewa and Khalti** as the first payment providers.

## Open questions for the owner

See [requirements §6](../product/requirements.md#6-open-questions-for-the-owner).

## Next phase (needs approval)

Phase 1: Monorepo scaffolding & tooling. See [roadmap](../development/roadmap.md).

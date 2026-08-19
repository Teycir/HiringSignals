# CI/CD Quality Gate

This repository uses GitHub Actions for CI/CD quality enforcement to ensure code quality before allowing remote pushes.

## Pre-Push Quality Gate

Before pushing to remote, a git pre-push hook enforces CI/CD quality gates locally:

1. **Typecheck** - Runs `pnpm -r typecheck` across all workspaces
2. **Lint** - Runs `pnpm -r lint` across all workspaces
3. **Push blocked** - If either check fails, the push is aborted

To install the pre-push hook:
```bash
./scripts/setup-pre-push-hook.sh
```

This ensures that code quality issues are caught locally before reaching CI/CD.

## GitHub Actions CI

The CI workflow (`.github/workflows/ci.yml`) runs on every push to main and pull requests:

1. Installs dependencies
2. Runs typecheck across all workspaces
3. Runs lint across all workspaces
4. Fails the workflow if either check fails

This provides a remote quality gate that ensures no code that fails typecheck or lint can be merged to main.

## Manual Deployment

For local deployment, you can use the package scripts:

```bash
# Deploy API
cd apps/api
pnpm deploy

# Deploy Web
cd apps/web
pnpm deploy
```

These require Cloudflare authentication in your environment.

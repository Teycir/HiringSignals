# Deployment Setup

This repository uses GitHub Actions for automated deployment to Cloudflare Workers.

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

## Deployment Workflow

The deployment workflow (`.github/workflows/deploy.yml`) automatically:

1. Runs on main branch pushes (after pre-push hook passes)
2. Installs dependencies and builds all packages
3. Typechecks and lints the codebase (redundant check)
4. Deploys `apps/api` to Cloudflare Workers (`hiring-signals-api`)
5. Deploys `apps/web` to Cloudflare Workers (`hiring-signals-web`)

You can also trigger deployments manually via the GitHub Actions UI.

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

## Security Notes

- Pre-push hook prevents pushing code that fails typecheck or lint
- Deployment only runs on the main branch to prevent accidental deployments from feature branches
- The workflow performs typecheck and lint before deployment to ensure code quality
- For additional safety, consider adding manual approval gates in the deployment workflow

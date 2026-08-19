# Deployment Setup

This repository uses GitHub Actions for automated deployment to Cloudflare Workers.

## Deployment Workflow

The deployment workflow (`.github/workflows/deploy.yml`) automatically:

1. Runs on main branch pushes
2. Installs dependencies and builds all packages
3. Typechecks and lints the codebase
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

- Deployment only runs on the main branch to prevent accidental deployments from feature branches
- The workflow performs typecheck and lint before deployment to ensure code quality
- For additional safety, consider adding manual approval gates in the deployment workflow

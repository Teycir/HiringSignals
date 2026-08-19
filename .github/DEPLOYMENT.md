# Deployment Setup

This repository uses GitHub Actions for automated deployment to Cloudflare Workers.

## Required GitHub Secrets

The deployment workflow requires the following GitHub repository secret:

### `CLOUDFLARE_API_TOKEN`

A Cloudflare API token with permissions to deploy Workers to your Cloudflare account.

**To set this secret:**

1. Generate a Cloudflare API token with the following permissions:
   - Account > Workers Scripts > Edit
   - Account > Workers Scripts Inventory > Edit
   - Account > Account Settings > Read (for account ID resolution)

2. Set the secret in your GitHub repository:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN
   ```
   Paste your token value when prompted.

**Token permissions details:**
- Must have access to the Cloudflare account specified in `apps/api/wrangler.toml` (account_id)
- Should be scoped to the specific account to follow principle of least privilege
- Must include D1, KV, Queue, Vectorize, and Workers AI permissions if you want full deployment capabilities

## Deployment Workflow

The deployment workflow (`.github/workflows/deploy.yml`) automatically:

1. Runs after CI passes on main branch pushes
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

These require `CLOUDFLARE_API_TOKEN` to be set in your environment (or via `.env.local`).

## Security Notes

- The `CLOUDFLARE_API_TOKEN` secret is never logged or exposed in workflow logs
- Deployment only runs on the main branch to prevent accidental deployments from feature branches
- The workflow performs typecheck and lint before deployment to ensure code quality
- For additional safety, consider adding manual approval gates in the deployment workflow

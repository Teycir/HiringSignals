#!/bin/bash
# Setup script for pre-push git hook
# Run this script to install the pre-push hook locally

set -e

HOOKS_DIR=".git/hooks"
HOOK_FILE="$HOOKS_DIR/pre-push"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Setting up pre-push hook..."

# Create hooks directory if it doesn't exist
mkdir -p "$HOOKS_DIR"

# Create the pre-push hook
cat > "$HOOK_FILE" << 'EOF'
#!/bin/bash
# Pre-push hook: run typecheck and lint before allowing push to remote
# This ensures CI/CD quality gates are enforced locally before pushing

set -e

echo "Running pre-push checks..."

# Run typecheck
echo "Running typecheck..."
pnpm -r typecheck
if [ $? -ne 0 ]; then
    echo "❌ Typecheck failed. Push aborted."
    exit 1
fi
echo "✅ Typecheck passed"

# Run lint
echo "Running lint..."
pnpm -r lint
if [ $? -ne 0 ]; then
    echo "❌ Lint failed. Push aborted."
    exit 1
fi
echo "✅ Lint passed"

echo "✅ All pre-push checks passed. Proceeding with push..."
EOF

# Make the hook executable
chmod +x "$HOOK_FILE"

echo "✅ Pre-push hook installed successfully!"
echo "The hook will run typecheck and lint before every push to remote."

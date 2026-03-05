#!/usr/bin/env bash
#
# Publish github-router to npm as the UNSCOPED package "github-router".
#
# The source package.json uses the scoped name @animeshkundu/github-router
# for GitHub Packages compatibility, but the canonical install target is
# the unscoped "github-router" package on npmjs.org.
#
# Usage:
#   ./publish/release.sh [version]
#
# Arguments:
#   version   semver version to publish (e.g. 0.3.14). If omitted, bumps patch.
#
# Prerequisites:
#   - NPM_TOKEN env var set with a valid npmjs.org publish token
#   - bun installed (for build)
#
# The script will:
#   1. Build dist/ from source
#   2. Run tests
#   3. Temporarily rewrite package.json (name + version) for publish
#   4. Publish to npmjs.org
#   5. Restore package.json
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# --- Validate prerequisites ---

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "ERROR: NPM_TOKEN environment variable is not set."
  echo "Generate a publish token at https://www.npmjs.com/settings/animeshkundu/tokens"
  exit 1
fi

if ! command -v bun &>/dev/null; then
  echo "ERROR: bun is required but not found on PATH."
  exit 1
fi

# --- Determine version ---

CURRENT_VERSION=$(node -p "require('./package.json').version")

if [ -n "${1:-}" ]; then
  VERSION="$1"
else
  # Auto-bump patch: 0.3.10 -> 0.3.11
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
fi

echo "Publishing github-router@${VERSION} (source: @animeshkundu/github-router@${CURRENT_VERSION})"
echo ""

# --- Build and test ---

echo "==> Building..."
bun run build

echo "==> Running tests..."
bun test

# --- Publish ---

echo "==> Preparing package.json for publish..."

# Save original
cp package.json package.json.bak

# Rewrite name and version for unscoped publish
node -e "
  const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
  pkg.name = 'github-router';
  pkg.version = '${VERSION}';
  delete pkg.publishConfig;  // not needed for unscoped
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "==> Publishing github-router@${VERSION} to npmjs.org..."

npm publish --access public \
  --ignore-scripts \
  --registry=https://registry.npmjs.org \
  "--//registry.npmjs.org/:_authToken=${NPM_TOKEN}"

PUBLISH_EXIT=$?

# --- Restore ---

echo "==> Restoring package.json..."
mv package.json.bak package.json

if [ $PUBLISH_EXIT -eq 0 ]; then
  echo ""
  echo "Published github-router@${VERSION}"
  echo "Install: npm install -g github-router@${VERSION}"
else
  echo ""
  echo "ERROR: Publish failed with exit code ${PUBLISH_EXIT}"
  exit $PUBLISH_EXIT
fi

#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Ensure we operate from the project root
cd "$PROJECT_ROOT"

# Safety checks: ensure PROJECT_ROOT is valid and contains this project's files
if [[ -z "$PROJECT_ROOT" || "$PROJECT_ROOT" == "/" ]]; then
  echo "Error: Invalid project root '$PROJECT_ROOT'" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/package.json" ]] || [[ ! -d "$PROJECT_ROOT/node_modules/foldkit" ]]; then
  echo "Error: Expected project root at $PROJECT_ROOT with package.json and node_modules/foldkit" >&2
  exit 1
fi

TARGET_DIR="$PROJECT_ROOT/repos/foldkit"

# Safety check: ensure TARGET_DIR is strictly $PROJECT_ROOT/repos/foldkit
if [[ "$TARGET_DIR" != "$PROJECT_ROOT/repos/foldkit" ]]; then
  echo "Error: Target directory does not match expected path: $TARGET_DIR" >&2
  exit 1
fi

VERSION="$(node -p "require('./node_modules/foldkit/package.json').version")"
if [[ -z "$VERSION" ]]; then
  echo "Error: Could not determine foldkit version from node_modules/foldkit/package.json" >&2
  exit 1
fi

if [[ -d "$TARGET_DIR" ]]; then
  echo "Removing existing $TARGET_DIR..."
  rm -rf "$TARGET_DIR"
fi

mkdir -p "$PROJECT_ROOT/repos"

echo "Cloning foldkit@$VERSION into repos/foldkit..."
git clone --branch "foldkit@$VERSION" --depth 1 https://github.com/foldkit/foldkit.git "$TARGET_DIR"

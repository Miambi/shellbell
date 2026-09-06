#!/usr/bin/env bash
# Packs `shellbell` and installs the tarball into a throwaway prefix to prove `npx shellbell`
# would work. Publishes nothing and touches nothing outside $TMPDIR.
set -euo pipefail
cd "$(dirname "$0")/.."
PREFIX="$(mktemp -d)"
trap 'rm -rf "$PREFIX"' EXIT
rm -f shellbell-*.tgz
pnpm pack
TARBALL="$(ls shellbell-*.tgz)"
echo "packed $TARBALL"
npm install -g --prefix "$PREFIX" "./$TARBALL"
"$PREFIX/bin/shellbell" --version
npm uninstall -g --prefix "$PREFIX" shellbell
rm -f "$TARBALL"
echo "pack-smoke: ok"

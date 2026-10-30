#!/bin/bash
set -e

rm -rf dist/modules
tsc -p src --stripInternal false

rm -rf dist/packages
tsc -p tsconfig.packages.json

tsc -p tsconfig.vitest.json --noEmit

tsc -p scripts --noEmit

tsc -p tsconfig.vite.json --noEmit

# A rebase that silently drops upstream code must fail here, not ship (see FORK.md).
npx tsx scripts/check-upstream-deletions.ts

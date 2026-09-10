#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p .release
bun pm pack --filename .release/package.tgz --ignore-scripts
tarball="$PWD/.release/package.tgz"
typechecker="$PWD/node_modules/typescript/bin/tsc"
consumer="$(mktemp -d)"
trap 'rm -rf "$consumer"' EXIT
cp scripts/package-consumer.mjs "$consumer/"
cp scripts/package-consumer.ts "$consumer/"
printf '{"private":true,"type":"module"}\n' > "$consumer/package.json"
cd "$consumer"
bun add --ignore-scripts "$tarball"
node "$typechecker" --noEmit --strict --module nodenext --target es2022 package-consumer.ts
node package-consumer.mjs

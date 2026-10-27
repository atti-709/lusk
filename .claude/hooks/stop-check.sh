#!/bin/bash
# Stop hook: a session may not end with the repo failing its typecheck or unit tests.
# Runs only when the checkout differs from origin/main in code files, so planning sessions
# and doc-only changes pay nothing. Exit 2 sends Claude back to work with the output.
set -u
input=$(cat)
if printf '%s' "$input" | grep -q '"stop_hook_active": *true'; then exit 0; fi
cwd=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd",""))' 2>/dev/null)
[ -n "$cwd" ] && cd "$cwd" || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
base=$(git rev-parse --verify -q origin/main || git rev-parse --verify -q main) || exit 0
changed=$(git diff --name-only "$base" -- . 2>/dev/null; git diff --name-only --cached 2>/dev/null; git diff --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)
if ! printf '%s\n' "$changed" | grep -Eq '\.(ts|tsx|js|mjs|cjs|json|py)$'; then exit 0; fi
if [ ! -d node_modules ]; then
  echo "node_modules is missing in $cwd: run npm install, then make sure typecheck and tests pass before finishing." >&2
  exit 2
fi
out=$( (npx tsc --noEmit -p server && npx tsc --noEmit -p client && npm test -w server --silent) 2>&1 )
status=$?
if [ $status -ne 0 ]; then
  echo "The repo must typecheck and pass server unit tests before the session ends:" >&2
  printf '%s\n' "$out" | tail -60 >&2
  exit 2
fi
exit 0

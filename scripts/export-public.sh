#!/usr/bin/env bash
# Writes the public tree: every file tracked on a ref (default main) except .product/, the private loop state,
# as one new commit on the local branch `publish`. Each export is a snapshot on top of the previous one, so the
# public history never carries a private commit or message. Publish with: git push origin publish:main
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ref="${1:-main}"
git rev-parse -q --verify "$ref^{commit}" >/dev/null || { echo "export-public: no such ref: $ref" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Build the tree in a scratch index, so the working tree and the real index are never touched.
export GIT_INDEX_FILE="$tmp/index"
git read-tree "$ref"
git rm -r --cached -q --ignore-unmatch -- .product
tree="$(git write-tree)"
unset GIT_INDEX_FILE

if git ls-tree -r --name-only "$tree" | grep -q '^\.product/'; then
  echo "export-public: .product/ is still in the tree; nothing written" >&2
  exit 1
fi

parent="$(git rev-parse -q --verify refs/heads/publish || true)"
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "export-public: publish already matches $ref; nothing to do"
  exit 0
fi

msg="Snapshot $(date -u +%Y-%m-%d)"
if [ -n "$parent" ]; then
  commit="$(git commit-tree "$tree" -p "$parent" -m "$msg")"
else
  commit="$(git commit-tree "$tree" -m "$msg")"
fi
git update-ref refs/heads/publish "$commit" ${parent:+"$parent"}
echo "export-public: publish is now $(git rev-parse --short "$commit") ($(git ls-tree -r --name-only "$tree" | wc -l | tr -d ' ') files, from $ref)"
echo "export-public: publish with: git push origin publish:main"

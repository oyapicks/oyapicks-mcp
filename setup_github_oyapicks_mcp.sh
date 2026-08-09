#!/bin/zsh
# setup_github_oyapicks_mcp.sh
# Adds repository metadata to package.json, bumps to 0.1.1, and sets up git.
# Run from inside ~/Documents/oyapicks-mcp

set -e

if [ ! -f "package.json" ] || [ ! -f "index.js" ]; then
  echo "ABORT: not in the oyapicks-mcp folder."
  echo "Run: cd ~/Documents/oyapicks-mcp"
  exit 1
fi

# ─────────────────────────────────────────── patch package.json
python3 << 'PYEOF'
import sys

src = open("package.json").read()

# 1. Add repository / homepage / bugs after the license line
old_license = '  "license": "MIT",\n'
new_license = '''  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/oyapicks/oyapicks-mcp.git"
  },
  "homepage": "https://oyapicks.app",
  "bugs": {
    "url": "https://github.com/oyapicks/oyapicks-mcp/issues"
  },
'''

if src.count(old_license) != 1:
    print("ABORT: could not find the license line exactly once. Nothing changed.")
    sys.exit(1)

if '"repository"' in src:
    print("ABORT: package.json already has a repository field. Nothing changed.")
    sys.exit(1)

src = src.replace(old_license, new_license)

# 2. Bump version
old_ver = '"version": "0.1.0",'
new_ver = '"version": "0.1.1",'

if src.count(old_ver) != 1:
    print("ABORT: version is not 0.1.0. Nothing changed.")
    sys.exit(1)

src = src.replace(old_ver, new_ver)

open("package.json", "w").write(src)
print("package.json updated: repository added, version bumped to 0.1.1")
PYEOF

# ─────────────────────────────────────────── git setup
if [ -d ".git" ]; then
  echo "git already initialised here, skipping init."
else
  git init -q
  git branch -M main
  echo "git initialised on branch main."
fi

git add -A
git commit -q -m "oyapicks-mcp 0.1.1 - add repository metadata" || echo "Nothing new to commit."

echo ""
echo "Local git is ready. Files committed:"
git ls-files
echo ""
echo "NEXT: create the repo on GitHub (see chat), then run the push commands."
echo ""

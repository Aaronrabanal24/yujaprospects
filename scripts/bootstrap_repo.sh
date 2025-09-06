#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null; then
  echo "Install GitHub CLI (gh) first: https://cli.github.com/" >&2
  exit 1
fi

if ! command -v firebase >/dev/null; then
  echo "Install Firebase CLI first: npm i -g firebase-tools" >&2
  exit 1
fi

read -rp "GitHub repo name (e.g. ypi): " REPO
read -rp "GitHub owner (your username or org): " OWNER
read -rp "Firebase project id (e.g. ypi-dev-1234): " FBID

echo "Creating repo $OWNER/$REPO (private)…"
gh repo create "$OWNER/$REPO" --private --source=. --remote=origin --push

echo "Creating FIREBASE_TOKEN (you may be prompted in a browser)…"
TOKEN=$(firebase login:ci)
echo "Setting repo secrets…"
gh secret set FIREBASE_PROJECT_ID -b"$FBID"
gh secret set FIREBASE_TOKEN -b"$TOKEN"

git add .
git commit -m "Initial commit: YuJa Prospect Intelligence (Firebase)"
git push -u origin main || true

echo "All set. Open https://github.com/$OWNER/$REPO/actions to watch the deploy."

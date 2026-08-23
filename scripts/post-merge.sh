#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Database changes require an explicit, reviewed migration and approval. Never
# mutate whichever database DATABASE_URL happens to reference after a Git merge.
echo "Dependencies installed. Database schema was not changed."

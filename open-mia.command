#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d "node_modules/electron" ]; then
  echo "Installing Mia dependencies..."
  npm install
fi

npm run open

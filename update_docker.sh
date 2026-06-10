#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

git pull

docker build -t spherelab .
docker rm -f spherelab 2>/dev/null || true
docker run -d --name spherelab --restart unless-stopped -p 80:80 spherelab

echo "Done — http://$(curl -sf ifconfig.me || echo localhost)/"

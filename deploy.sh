#!/bin/bash
set -e

REPO_DIR="/opt/m365-security"
cd "$REPO_DIR"

echo "🔄 Pulling latest changes from GitHub..."
git fetch origin
git reset --hard origin/main

echo "🐳 Building and deploying Docker container..."
docker compose down
docker compose up -d --build

echo "✅ Deployment completed successfully!"
echo "📊 Container status:"
docker ps | grep m365-security-website

echo ""
echo "🌐 Test deployment:"
echo "curl -I http://127.0.0.1:8082"

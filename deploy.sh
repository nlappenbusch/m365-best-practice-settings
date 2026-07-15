#!/bin/bash
set -euo pipefail

REPO_DIR="/opt/m365-security"
cd "$REPO_DIR"

echo "🔄 Pulling latest changes from GitHub..."
git fetch origin main
git reset --hard origin/main

# Compose-Vars aus der Shell raus — Shell-Env wuerde .env-Werte ueberschreiben.
unset ADMIN_USER ADMIN_PASSWORD 2>/dev/null || true

# Erst bauen, dann neu starten — haelt die Downtime minimal
# (der api-Build mit pwsh + ExchangeOnlineManagement dauert beim ersten Mal einige Minuten).
echo "🐳 Building images (website + api)..."
docker compose build

echo "♻️  Restarting stack..."
docker compose down --remove-orphans
sleep 3
docker compose up -d

# Self-healing: in manchen LXCs bleibt ein Container nach up in "Created" haengen.
sleep 3
for c in m365-security-website m365-security-api; do
  if ! docker ps --filter "name=$c" --filter status=running -q | grep -q .; then
    docker start "$c" || true
    sleep 3
  fi
  if ! docker ps --filter "name=$c" --filter status=running -q | grep -q .; then
    echo "ERROR: $c not running"
    docker logs "$c" --tail=40 || true
    exit 1
  fi
done

echo "🧪 Smoke-Test..."
curl -fsS -o /dev/null http://127.0.0.1:8082 && echo "  ✓ Website erreichbar"
health_ok=0
for i in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:8082/api/health 2>/dev/null | grep -q '"ok":true'; then
    health_ok=1
    break
  fi
  sleep 2
done
if [ "$health_ok" = "1" ]; then
  echo "  ✓ API health OK"
else
  echo "ERROR: /api/health nicht OK"
  docker logs m365-security-api --tail=40 || true
  exit 1
fi

docker image prune -f >/dev/null

echo "✅ Deployment completed successfully!"
echo "📊 Container status:"
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep m365-security

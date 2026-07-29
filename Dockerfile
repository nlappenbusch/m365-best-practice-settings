# --- Stage 1: Svelte/Vite-Frontend bauen ---
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: nginx serviert das gebaute SPA ---
FROM nginx:alpine
COPY --from=frontend /fe/dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Default-Include-Dateien, damit nginx auch ohne Entrypoint-Lauf startet
# (fail-open: keine IP-Sperre, private Real-IP-Ranges).
RUN printf 'set_real_ip_from 10.0.0.0/8;\nset_real_ip_from 172.16.0.0/12;\nset_real_ip_from 192.168.0.0/16;\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n' > /etc/nginx/real_ip.conf \
 && printf '# keine IP-Beschraenkung (ALLOWED_IPS leer)\n' > /etc/nginx/allowlist.conf

# Entrypoint-Hook: generiert real_ip.conf + allowlist.conf aus ENV vor dem Start.
COPY docker/40-allowlist.sh /docker-entrypoint.d/40-allowlist.sh
RUN chmod +x /docker-entrypoint.d/40-allowlist.sh

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

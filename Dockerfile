# --- Stage 1: neues Framework-Frontend bauen (Preview unter /preview/) ---
# Laeuft parallel zum alten Vanilla-Tool, das unter / unangetastet bleibt.
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: nginx mit altem Root-Tool + der Preview ---
FROM nginx:alpine

# Vanilla-Tool (bleibt die produktive Oberflaeche unter /)
COPY index.html app.js session.js livedeploy.js downloads.js styles.css domains.js robots.txt /usr/share/nginx/html/

# Cache-Busting: Platzhalter in den Asset-URLs pro Build stempeln.
RUN sed -i "s/__ASSET_VERSION__/$(date +%s)/g" /usr/share/nginx/html/index.html

# Neues Frontend als Preview (Vite baut mit base=/preview/)
COPY --from=frontend /fe/dist/ /usr/share/nginx/html/preview/

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

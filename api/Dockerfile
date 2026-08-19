FROM node:20-bookworm-slim

# PowerShell 7 (Microsoft apt repo) + ExchangeOnlineManagement-Modul
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
    && dpkg -i packages-microsoft-prod.deb \
    && rm packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends powershell openssl \
    && apt-get purge -y wget \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN pwsh -NoProfile -Command "Set-PSRepository PSGallery -InstallationPolicy Trusted; Install-Module ExchangeOnlineManagement -Scope AllUsers -Force"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY assets ./assets

ENV STATE_DIR=/app/state \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]

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

# Maester-Security-Audit (maester.dev): Testframework + Graph-Auth + Pester.
# Die Testsuite wird beim Build eingefroren (/opt/maester-tests) — aktualisiert
# sich also mit jedem Deploy, nicht zur Laufzeit.
RUN pwsh -NoProfile -Command "Set-PSRepository PSGallery -InstallationPolicy Trusted; Install-Module Microsoft.Graph.Authentication -Scope AllUsers -Force; Install-Module Pester -Scope AllUsers -Force -SkipPublisherCheck; Install-Module Maester -Scope AllUsers -Force" \
    && pwsh -NoProfile -Command "New-Item -ItemType Directory -Path /opt/maester-tests -Force | Out-Null; Install-MaesterTests -Path /opt/maester-tests"

# Teams- und SharePoint-Verbindung fuer die Maester-Tests (app-only per Cert).
RUN pwsh -NoProfile -Command "Set-PSRepository PSGallery -InstallationPolicy Trusted; Install-Module MicrosoftTeams -Scope AllUsers -Force; Install-Module PnP.PowerShell -Scope AllUsers -Force"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY assets ./assets
# Die Baseline ist Teil des Images: lib/baseline.js liest sie zur Laufzeit aus
# /app/baseline. Fehlt sie, meldet die Wissensseite ENOENT.
COPY baseline ./baseline

ENV STATE_DIR=/app/state \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]

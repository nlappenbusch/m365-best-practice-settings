#!/bin/sh
# Generiert vor dem nginx-Start zwei Include-Dateien aus Umgebungsvariablen:
#   /etc/nginx/real_ip.conf   – welchen Upstreams (NPM) wir X-Forwarded-For glauben
#   /etc/nginx/allowlist.conf – erlaubte Quell-IPs/Ranges (allow ...; deny all;)
# Wird vom offiziellen nginx-Image automatisch ausgefuehrt (/docker-entrypoint.d/*.sh).
#
# ENV:
#   ALLOWED_IPS   Komma-/Leerzeichen-getrennt, IPs und CIDR: "83.150.41.64, 10.0.0.0/24"
#                 Leer/nicht gesetzt = KEINE Beschraenkung (fail-open).
#   TRUSTED_PROXY Vertrauenswuerdige Upstreams (NPM) fuer X-Forwarded-For.
#                 Leer = private Default-Ranges. Fuer exakte Client-IP hinter dem
#                 NPM sollte hier die reale NPM-Quell-IP stehen (sonst spoofbar).
set -eu

REAL_IP_FILE=/etc/nginx/real_ip.conf
ALLOW_FILE=/etc/nginx/allowlist.conf

split() { printf '%s\n' "$1" | tr ',;\t ' '\n\n\n\n'; }
is_ip()  { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$'; }
is_ip6() { printf '%s' "$1" | grep -Eq '^[0-9A-Fa-f:]+(/[0-9]{1,3})?$'; }

# ---- real_ip (Upstream-Vertrauen fuer X-Forwarded-For) ----
: > "$REAL_IP_FILE"
TRUSTED="${TRUSTED_PROXY:-}"
[ -z "$TRUSTED" ] && TRUSTED="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
split "$TRUSTED" | while IFS= read -r cidr; do
  [ -z "$cidr" ] && continue
  if is_ip "$cidr" || is_ip6 "$cidr"; then
    echo "set_real_ip_from $cidr;" >> "$REAL_IP_FILE"
  else
    echo "[allowlist] WARNUNG: ungueltiger TRUSTED_PROXY-Eintrag ignoriert: '$cidr'" >&2
  fi
done
{
  echo "real_ip_header X-Forwarded-For;"
  echo "real_ip_recursive on;"
} >> "$REAL_IP_FILE"

# ---- allowlist ----
if [ -z "${ALLOWED_IPS:-}" ]; then
  echo "# ALLOWED_IPS leer -> keine IP-Beschraenkung" > "$ALLOW_FILE"
  echo "[allowlist] ALLOWED_IPS leer -> kein IP-Filter aktiv (Zugriff offen)" >&2
  exit 0
fi

: > "$ALLOW_FILE"
# Interne Quellen immer erlauben: Docker-Healthcheck/Smoke-Test (Loopback) und
# Inter-Container-Traffic. Externe Clients kommen ueber den NPM mit ihrer echten
# (oeffentlichen) IP an -> die werden weiter gefiltert; diese privaten Allows
# treffen sie nicht.
{
  echo "# intern (Healthcheck/Container) immer erlaubt:"
  echo "allow 127.0.0.1;"
  echo "allow 10.0.0.0/8;"
  echo "allow 172.16.0.0/12;"
  echo "allow 192.168.0.0/16;"
  echo "# aus ALLOWED_IPS:"
} >> "$ALLOW_FILE"

split "$ALLOWED_IPS" | while IFS= read -r ip; do
  [ -z "$ip" ] && continue
  if is_ip "$ip" || is_ip6 "$ip"; then
    echo "allow $ip;" >> "$ALLOW_FILE"
  else
    echo "[allowlist] WARNUNG: ungueltiger ALLOWED_IPS-Eintrag ignoriert: '$ip'" >&2
  fi
done
echo "deny all;" >> "$ALLOW_FILE"
echo "[allowlist] IP-Filter aktiv (siehe $ALLOW_FILE)" >&2

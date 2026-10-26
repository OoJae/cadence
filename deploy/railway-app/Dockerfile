# The Cadence web app on its own Railway service: Caddy serving a prebuilt web/dist
# (VITE_API=runners) with the production headers. Built from the directory
# deploy/railway-app/stage.sh assembles (the Caddyfile and dist only). No secrets,
# no volume, nothing to proxy.
FROM caddy:2.11.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY dist /srv/web
# The CSP header is read from the build's csp.txt; refuse an image without one.
RUN test -s /srv/web/csp.txt && test -s /srv/web/build.json && test -s /srv/web/index.html \
  && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# Serving files needs no privilege ($PORT is above 1024 on Railway).
USER 10001:10001

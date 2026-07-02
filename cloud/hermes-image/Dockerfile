FROM python:3.11-slim

ARG HERMES_VERSION=2026.5.29
ARG DEBIAN_APT_MIRROR=""
ARG DEBIAN_APT_SECURITY_MIRROR=""
ARG PIP_INDEX_URL=""
ARG PIP_EXTRA_INDEX_URL=""

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HERMES_ACCEPT_HOOKS=1 \
    GATEWAY_ALLOW_ALL_USERS=true \
    PYTHONPATH=/opt/mia-plugins

RUN if [ -n "$DEBIAN_APT_MIRROR" ]; then \
      security_mirror="${DEBIAN_APT_SECURITY_MIRROR:-${DEBIAN_APT_MIRROR}-security}"; \
      find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -print0 \
        | xargs -0 -r sed -i \
          -e "s|http://deb.debian.org/debian-security|${security_mirror}|g" \
          -e "s|https://deb.debian.org/debian-security|${security_mirror}|g" \
          -e "s|http://deb.debian.org/debian|${DEBIAN_APT_MIRROR}|g" \
          -e "s|https://deb.debian.org/debian|${DEBIAN_APT_MIRROR}|g"; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Hermes ≥0.15 dropped the [web] extra; the runs API server (gateway/platforms/
# api_server.py) needs aiohttp, which now lives in the [messaging]/[slack] extras.
# Install the base package plus aiohttp and mcp directly so the API server and
# configured MCP tools load.
COPY hermes-agent-archive /tmp/hermes-agent-archive

RUN set -e; \
    pip_index_args=""; \
    if [ -n "$PIP_INDEX_URL" ]; then \
      pip_index_args="$pip_index_args --index-url $PIP_INDEX_URL"; \
    fi; \
    if [ -n "$PIP_EXTRA_INDEX_URL" ]; then \
      pip_index_args="$pip_index_args --extra-index-url $PIP_EXTRA_INDEX_URL"; \
    fi; \
    hermes_archive="/tmp/hermes-agent-${HERMES_VERSION}.tar.gz"; \
    hermes_url="https://github.com/NousResearch/hermes-agent/archive/refs/tags/v${HERMES_VERSION}.tar.gz"; \
    bundled_archive="/tmp/hermes-agent-archive/hermes-agent-${HERMES_VERSION}.tar.gz"; \
    if [ -f "$bundled_archive" ]; then \
      cp "$bundled_archive" "$hermes_archive"; \
    else \
      for attempt in 1 2 3 4 5 6 7 8 9 10; do \
        curl -fL --http1.1 --continue-at - --connect-timeout 30 --speed-limit 1024 --speed-time 60 --retry 3 --retry-delay 5 -o "$hermes_archive" "$hermes_url" && break; \
        if [ "$attempt" = "10" ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
      done; \
    fi; \
    python -m pip install --no-cache-dir $pip_index_args \
      "$hermes_archive" \
      "aiohttp==3.13.3" \
      "fastapi" \
      "uvicorn[standard]" \
      "mcp" \
      "ddgs"; \
    rm -rf "$hermes_archive" /tmp/hermes-agent-archive

COPY mia_plugins /opt/mia-plugins/mia_plugins
COPY entrypoint.sh /usr/local/bin/mia-hermes-entrypoint

RUN chmod +x /usr/local/bin/mia-hermes-entrypoint

EXPOSE 8765

ENTRYPOINT ["mia-hermes-entrypoint"]

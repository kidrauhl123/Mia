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
RUN set -e; \
    pip_index_args=""; \
    if [ -n "$PIP_INDEX_URL" ]; then \
      pip_index_args="$pip_index_args --index-url $PIP_INDEX_URL"; \
    fi; \
    if [ -n "$PIP_EXTRA_INDEX_URL" ]; then \
      pip_index_args="$pip_index_args --extra-index-url $PIP_EXTRA_INDEX_URL"; \
    fi; \
    python -m pip install --no-cache-dir $pip_index_args \
      "hermes-agent @ https://github.com/NousResearch/hermes-agent/archive/refs/tags/v${HERMES_VERSION}.tar.gz" \
      "aiohttp==3.13.3" \
      "mcp" \
      "ddgs"

COPY mia_plugins /opt/mia-plugins/mia_plugins
COPY entrypoint.sh /usr/local/bin/mia-hermes-entrypoint

RUN chmod +x /usr/local/bin/mia-hermes-entrypoint

EXPOSE 8765

ENTRYPOINT ["mia-hermes-entrypoint"]

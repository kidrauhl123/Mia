FROM python:3.11-slim

ARG HERMES_VERSION=2026.5.7

ENV PYTHONUNBUFFERED=1 \
    HERMES_ACCEPT_HOOKS=1 \
    GATEWAY_ALLOW_ALL_USERS=true \
    PYTHONPATH=/opt/mia-plugins

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir \
      "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/refs/tags/v${HERMES_VERSION}.tar.gz"

COPY mia_plugins /opt/mia-plugins/mia_plugins
COPY entrypoint.sh /usr/local/bin/mia-hermes-entrypoint

RUN chmod +x /usr/local/bin/mia-hermes-entrypoint

EXPOSE 8765

ENTRYPOINT ["mia-hermes-entrypoint"]

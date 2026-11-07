FROM node:24-bookworm-slim

ARG PI_VERSION
ARG EXTENSIONS_SOURCE=none

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep fd-find ncurses-term openssh-client ca-certificates tini socat netcat-openbsd \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

RUN userdel --remove node \
 && groupadd --gid 1000 pi \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/pi --shell /bin/bash pi

COPY trust.pem /build/trust.pem

RUN if [ -s /build/trust.pem ]; then \
      cp /build/trust.pem /usr/local/share/ca-certificates/pi-sandbox-build.crt && update-ca-certificates; \
    fi

ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

RUN test -n "${PI_VERSION}" || { echo "PI_VERSION build argument is required" >&2; exit 1; } \
 && npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

COPY . /build/

RUN mkdir -p /opt/pi-sandbox/extensions \
 && if [ -z "${EXTENSIONS_SOURCE}" ] || [ "${EXTENSIONS_SOURCE}" = "none" ]; then \
      echo "EXTENSIONS_SOURCE=none: building without pi-extensions-mz"; \
    elif [ -f "/build/${EXTENSIONS_SOURCE}" ]; then \
      npm install --prefix /opt/pi-sandbox/extensions --omit=dev --legacy-peer-deps "/build/${EXTENSIONS_SOURCE}"; \
    else \
      npm install --prefix /opt/pi-sandbox/extensions --omit=dev --legacy-peer-deps "${EXTENSIONS_SOURCE}"; \
    fi \
 && npm cache clean --force

RUN mkdir -p /opt/pi-sandbox/render /etc/pi-sandbox \
 && cp /build/entrypoint.sh /usr/local/bin/pi-sandbox-entrypoint \
 && printf '#!/bin/sh\necho "pi %s is managed by the sandbox and follows the launcher"\n' "${PI_VERSION}" > /usr/local/bin/pi-sandbox-self-update \
 && chmod 0755 /usr/local/bin/pi-sandbox-entrypoint /usr/local/bin/pi-sandbox-self-update

USER pi

ENV HOME=/home/pi \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PI_SELF_UPDATE_COMMAND=/usr/local/bin/pi-sandbox-self-update

RUN mkdir -p /home/pi/.pi/agent \
 && if [ -d /opt/pi-sandbox/extensions/node_modules/pi-extensions-mz ]; then \
      pi install /opt/pi-sandbox/extensions/node_modules/pi-extensions-mz; \
    fi

USER root

RUN if [ -f /home/pi/.pi/agent/settings.json ]; then \
      cp /home/pi/.pi/agent/settings.json /opt/pi-sandbox/settings.json && chmod 0444 /opt/pi-sandbox/settings.json; \
    fi \
 && if [ -f /usr/local/share/ca-certificates/pi-sandbox-build.crt ]; then \
      rm /usr/local/share/ca-certificates/pi-sandbox-build.crt && update-ca-certificates --fresh; \
    fi \
 && rm -rf /build

USER pi

WORKDIR /home/pi

ENTRYPOINT ["/usr/local/bin/pi-sandbox-entrypoint"]

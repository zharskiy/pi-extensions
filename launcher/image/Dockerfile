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

RUN cp /build/models.json /build/auth.json /opt/pi-sandbox/ \
 && cp /build/entrypoint.sh /usr/local/bin/pi-sandbox-entrypoint \
 && rm -rf /build \
 && chmod 0444 /opt/pi-sandbox/models.json /opt/pi-sandbox/auth.json \
 && chmod 0755 /usr/local/bin/pi-sandbox-entrypoint

USER pi

ENV HOME=/home/pi \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

RUN mkdir -p /home/pi/.pi/agent \
 && if [ -d /opt/pi-sandbox/extensions/node_modules/pi-extensions-mz ]; then \
      pi install /opt/pi-sandbox/extensions/node_modules/pi-extensions-mz; \
    fi

USER root

RUN if [ -f /home/pi/.pi/agent/settings.json ]; then \
      cp /home/pi/.pi/agent/settings.json /opt/pi-sandbox/settings.json && chmod 0444 /opt/pi-sandbox/settings.json; \
    fi

USER pi

WORKDIR /home/pi

ENTRYPOINT ["/usr/local/bin/pi-sandbox-entrypoint"]

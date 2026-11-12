FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep fd-find ncurses-term openssh-client ca-certificates socat less procps \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

RUN userdel --remove node \
 && groupadd --gid 1000 pi \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/pi --shell /bin/bash pi

COPY trust.pem proxy-ca.pem /build/

RUN if [ -s /build/trust.pem ]; then \
      cp /build/trust.pem /usr/local/share/ca-certificates/pi-sandbox-build.crt && update-ca-certificates; \
    fi

ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

ARG PI_VERSION

RUN test -n "${PI_VERSION}" || { echo "PI_VERSION build argument is required" >&2; exit 1; } \
 && npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

COPY bash-env.sh /usr/local/lib/pi-sandbox/

COPY entrypoint.sh /usr/local/bin/pi-sandbox-entrypoint

RUN mkdir -p /opt/pi-sandbox/render /etc/pi-sandbox \
 && chmod 0644 /usr/local/lib/pi-sandbox/bash-env.sh \
 && sed -i '1i . /usr/local/lib/pi-sandbox/bash-env.sh' /etc/bash.bashrc \
 && printf '#!/bin/sh\necho "pi %s is managed by the sandbox and follows the launcher"\n' "${PI_VERSION}" > /usr/local/bin/pi-sandbox-self-update \
 && printf '%s\n' '#!/bin/sh' 'echo "pi sandbox commands run on the host; ask the user to run pi sandbox $* there" >&2' 'exit 2' > /usr/local/bin/pi-sandbox \
 && chmod 0755 /usr/local/bin/pi-sandbox-entrypoint /usr/local/bin/pi-sandbox-self-update /usr/local/bin/pi-sandbox \
 && rm -f /usr/local/share/ca-certificates/pi-sandbox-build.crt \
 && if [ -s /build/proxy-ca.pem ]; then \
      cp /build/proxy-ca.pem /usr/local/share/ca-certificates/pi-sandbox-proxy.crt; \
    fi \
 && update-ca-certificates --fresh \
 && rm -rf /build

USER pi

ENV HOME=/home/pi \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PI_SELF_UPDATE_COMMAND=/usr/local/bin/pi-sandbox-self-update \
    BASH_ENV=/usr/local/lib/pi-sandbox/bash-env.sh

RUN mkdir -p /home/pi/.pi/agent

WORKDIR /home/pi

ENTRYPOINT ["/usr/local/bin/pi-sandbox-entrypoint"]

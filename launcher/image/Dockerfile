FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep fd-find ncurses-term openssh-client ca-certificates socat netcat-openbsd curl jq python3 python3-venv make unzip less procps xz-utils \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

RUN userdel --remove node \
 && groupadd --gid 1000 pi \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/pi --shell /bin/bash pi

COPY trust.pem /build/

RUN if [ -s /build/trust.pem ]; then \
      cp /build/trust.pem /usr/local/share/ca-certificates/pinata-build.crt && update-ca-certificates; \
    fi

ARG GLAB_VERSION=1.128.0
ARG GLAB_SHA256_AMD64=b42db1c339cb66df2dbdaf190b8c4e359cb2ea3f7ac53e46302b04777f2cf405
ARG GLAB_SHA256_ARM64=88e68a179fc25c3751e7950aa4b1b47b184cade590b70d9ca4aafff6648c655e

RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) sum="${GLAB_SHA256_AMD64}" ;; \
      arm64) sum="${GLAB_SHA256_ARM64}" ;; \
      *) echo "no glab package for $arch" >&2; exit 1 ;; \
    esac \
 && deb="/tmp/glab_${GLAB_VERSION}_linux_${arch}.deb" \
 && curl -fsSL -o "$deb" "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.deb" \
 && echo "$sum  $deb" | sha256sum -c - \
 && dpkg -i "$deb" \
 && rm -f "$deb"

ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

ARG PI_VERSION

RUN test -n "${PI_VERSION}" || { echo "PI_VERSION build argument is required" >&2; exit 1; } \
 && npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

RUN mkdir -p /opt/pinata/render \
 && printf '#!/bin/sh\necho "pi %s is managed by the sandbox and follows pinata"\n' "${PI_VERSION}" > /usr/local/bin/pinata-self-update \
 && printf '%s\n' '#!/bin/sh' 'echo "pinata commands run on the host; ask the user to run pinata $* there" >&2' 'exit 2' > /usr/local/bin/pinata \
 && chmod 0755 /usr/local/bin/pinata-self-update /usr/local/bin/pinata \
 && rm -f /usr/local/share/ca-certificates/pinata-build.crt \
 && update-ca-certificates --fresh \
 && rm -rf /build

USER pi

ENV HOME=/home/pi \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PI_SELF_UPDATE_COMMAND=/usr/local/bin/pinata-self-update

RUN mkdir -p /home/pi/.pi/agent

WORKDIR /home/pi

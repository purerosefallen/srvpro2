ARG GIT_IMAGE=alpine/git:v2.52.0
ARG NODE_IMAGE=node:24-alpine
ARG OCGCORE_BUILD_IMAGE=debian:bookworm-slim
ARG NO_RESOURCE=0
ARG USE_APK_CHINA_MIRROR=0
ARG PREMAKE5_REPO=https://github.com/premake/premake-core.git
ARG PREMAKE5_VERSION=5.0.0-beta8
ARG SCRIPT_REPO=https://code.moenext.com/nanahira/ygopro-scripts
ARG SCRIPT_BRANCH=master
ARG YGOPRO_REPO=https://code.moenext.com/nanahira/ygopro
ARG YGOPRO_BRANCH=server
ARG OCGCORE_REPO=https://code.moenext.com/nanahira/ygopro-core
ARG OCGCORE_BRANCH=master
ARG WINDBOT_REPO=https://code.moenext.com/nanahira/windbot
ARG WINDBOT_BRANCH=master
ARG USE_MAT_CACHER=0
ARG LUA_VERSION=5.4.8

FROM ${GIT_IMAGE} AS ygopro-loader
ARG NO_RESOURCE
ARG SCRIPT_REPO
ARG SCRIPT_BRANCH
ARG YGOPRO_REPO
ARG YGOPRO_BRANCH
ARG WINDBOT_REPO
ARG WINDBOT_BRANCH
RUN mkdir -p /resources/ygopro /resources/windbot && \
  if [ "$NO_RESOURCE" != "1" ]; then \
    git clone --branch="${SCRIPT_BRANCH}" --depth=1 "${SCRIPT_REPO}" /resources/ygopro/script && \
    git clone --branch="${YGOPRO_BRANCH}" --depth=1 "${YGOPRO_REPO}" /tmp/ygopro-resource && \
    git clone --branch="${WINDBOT_BRANCH}" --depth=1 "${WINDBOT_REPO}" /tmp/windbot-source && \
    cp /tmp/ygopro-resource/cards.cdb /resources/ygopro/cards.cdb && \
    cp /tmp/ygopro-resource/lflist.conf /resources/ygopro/lflist.conf && \
    cp /tmp/windbot-source/bots.json /resources/windbot/bots.json && \
    rm -rf /resources/ygopro/script/.git /tmp/ygopro-resource /tmp/windbot-source; \
  fi

FROM ${GIT_IMAGE} AS premake-source
ARG PREMAKE5_REPO
ARG PREMAKE5_VERSION
WORKDIR /usr/src
RUN git clone --branch="v${PREMAKE5_VERSION}" --depth=1 "${PREMAKE5_REPO}" premake

FROM ${OCGCORE_BUILD_IMAGE} AS ocgcore-build-env
RUN apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    emscripten \
    uuid-dev && \
  rm -rf /var/lib/apt/lists/*

FROM ocgcore-build-env AS premake-builder
COPY --from=premake-source /usr/src/premake /usr/src/premake
WORKDIR /usr/src/premake
RUN ./Bootstrap.sh

FROM ${GIT_IMAGE} AS ocgcore-source
ARG OCGCORE_REPO
ARG OCGCORE_BRANCH
ARG USE_MAT_CACHER
ARG LUA_VERSION
WORKDIR /usr/src
RUN set -eux; \
  if [ "${USE_MAT_CACHER}" = "1" ]; then \
    url_prefix="https://mat-cacher.moenext.com/"; \
  else \
    url_prefix=""; \
  fi; \
  fetch() { wget -O - "${url_prefix}$1" | tar zxf -; }; \
  git clone --branch="${OCGCORE_BRANCH}" --depth=1 "${OCGCORE_REPO}" ocgcore && \
  cd ocgcore && \
  fetch "https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz" && \
  mv "lua-${LUA_VERSION}" lua && \
  cp premake/lua.lua lua/premake5.lua

FROM ocgcore-build-env AS ocgcore-builder
COPY --from=premake-builder /usr/src/premake/bin/release/premake5 /usr/bin/premake5
COPY --from=ocgcore-source /usr/src/ocgcore /usr/src/ocgcore
WORKDIR /usr/src/ocgcore
RUN set -eux; \
  emcc --version && \
  ln -sf premake/dll.lua . && \
  premake5 gmake --file=dll.lua --os=emscripten && \
  make -C build config=release_wasm_cjs -j$(nproc) && \
  mkdir -p /resources && \
  cp build/bin/wasm_cjs/Release/libocgcore.wasm /resources/libocgcore.wasm

FROM ${NODE_IMAGE} AS base
ARG USE_APK_CHINA_MIRROR
LABEL Author="Nanahira <nanahira@momobako.com>"

WORKDIR /usr/src/app
RUN if [ "${USE_APK_CHINA_MIRROR}" = "1" ]; then \
      sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories; \
    fi
COPY ./package*.json ./

FROM base AS builder
RUN npm ci && npm cache clean --force
COPY . ./
RUN npm run build

FROM base
ENV NODE_ENV=production
ENV DEFAULT_OCGCORE_WASM_PATH=/usr/src/app/libocgcore.wasm
RUN apk add --no-cache libpq && \
  apk add --no-cache --virtual .pg-native-build-deps python3 make g++ libpq-dev && \
  npm ci --omit=dev && \
  npm install --omit=dev --no-save pg-native && \
  npm cache clean --force && \
  apk del .pg-native-build-deps
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=ygopro-loader /resources/ygopro ./ygopro
COPY --from=ygopro-loader /resources/windbot ./windbot
COPY --from=ocgcore-builder /resources/libocgcore.wasm ./libocgcore.wasm
COPY ./resource ./resource

ENV NODE_PG_FORCE_NATIVE=true
CMD [ "npm", "start" ]

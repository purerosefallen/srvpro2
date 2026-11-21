ARG NODE_IMAGE=node:26-alpine
ARG USE_APK_CHINA_MIRROR=0

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
RUN apk add --no-cache libpq && \
  apk add --no-cache --virtual .pg-native-build-deps python3 make g++ libpq-dev && \
  npm ci --omit=dev && \
  npm install --omit=dev --no-save pg-native && \
  npm cache clean --force && \
  apk del .pg-native-build-deps
COPY --from=builder /usr/src/app/dist ./dist
COPY ./resource ./resource

ENV NODE_PG_FORCE_NATIVE=true
CMD [ "npm", "start" ]

FROM debian:trixie-slim as ygopro-loader
RUN apt update && apt -y install wget git && \
  mkdir -p /resources/ygopro /resources/windbot && \
  git clone --depth=1 https://code.moenext.com/nanahira/ygopro-scripts /resources/ygopro/script && \
  wget -O /resources/ygopro/cards.cdb https://cdntx.moecube.com/ygopro-database/zh-CN/cards.cdb && \
  wget -O /resources/ygopro/lflist.conf https://cdntx.moecube.com/koishipro/contents/lflist.conf && \
  wget -O /resources/windbot/bots.json 'https://code.moenext.com/nanahira/windbot/-/raw/master/bots.json?inline=false'

FROM node:lts-trixie-slim as base
LABEL Author="Nanahira <nanahira@momobako.com>"

RUN apt update && apt -y install python3 build-essential libpq-dev && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /var/log/*
WORKDIR /usr/src/app
COPY ./package*.json ./

FROM base as builder
RUN npm ci && npm cache clean --force
COPY . ./
RUN npm run build

FROM base
ENV NODE_ENV production
RUN npm ci && npm install --no-save pg-native && npm cache clean --force
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=ygopro-loader /resources/ygopro ./ygopro
COPY --from=ygopro-loader /resources/windbot ./windbot
COPY ./resource ./resource

ENV NODE_PG_FORCE_NATIVE=true
CMD [ "npm", "start" ]

# SRVPro2

SRVPro2 管理 YGOPro 玩家的连接、房间、比赛和录像。develop 版通过 HTTP 调用 Angelus 查询卡片、选择禁限卡表和验卡，每盘开局时通过独立 WebSocket 驱动远端内核。

## 使用 Docker Compose 启动 develop 版

下面的单服示例使用 `git-registry.moenext.com/nanahira/ygoangelus` 提供内核和默认游戏资源、WindBot 提供人机、PostgreSQL 保存录像。玩家连接宿主机的 TCP 7911。Angelus 与 WindBot 只需在 Compose 网络内可达。

### 1. 准备目录

```bash
mkdir -p srvpro2/{data,ssl,postgres}
cd srvpro2
```

### 2. 创建 `docker-compose.yml`

```yaml
services:
  angelus:
    image: git-registry.moenext.com/nanahira/ygoangelus:develop
    restart: always
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 40

  windbot:
    restart: always
    image: git-registry.moenext.com/nanahira/windbot:develop

  postgres:
    restart: always
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: srvpro
      POSTGRES_PASSWORD: CHANGE_ME_DB_PASS
      POSTGRES_DB: srvpro2
    volumes:
      - ./postgres:/var/lib/postgresql/data

  srvpro2:
    restart: always
    image: git-registry.moenext.com/nanahira/srvpro2:develop
    depends_on:
      angelus:
        condition: service_healthy
      windbot:
        condition: service_started
      postgres:
        condition: service_started
    ports:
      - "7911:7911"
      - "7912:7912"
      - "7922:7922"
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - ./config.yaml:/usr/src/app/config.yaml:ro
      - ./ssl:/usr/src/app/ssl:ro
      - ./data:/usr/src/app/data
    environment:
      ANGELUS_ENDPOINT: http://angelus:3001
      TZ: Asia/Shanghai
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_USER: srvpro
      DB_PASS: CHANGE_ME_DB_PASS
      DB_NAME: srvpro2
      PORT: "7911"
      WS_PORT: "7912"
      API_PORT: "7922"
      ENABLE_SSL: "0"
      TRUSTED_PROXIES: "127.0.0.0/8,::1/128,172.16.0.0/12"
      WELCOME: "YGOPro Koishi Server"
      ENABLE_WINDBOT: "1"
      WINDBOT_ENDPOINT: "ws://windbot:2399"
      ENABLE_RANDOM_DUEL: "1"
      RANDOM_DUEL_BLANK_PASS_MODES: "M,S"
      ENABLE_MENU: "1"
      ENABLE_CLOUD_REPLAY: "1"
```

### 3. 创建 `config.yaml`

`config.yaml` 建议放“长期稳定配置”；端口、数据库地址、token 等易变信息放 `docker-compose.yml` 的 `environment`。

```yaml
host: "::"
wsHost: ""
apiHost: ""
logLevel: info
angelusEndpoint: http://angelus:3001

enableReconnect: 1
enableRoomlist: 1
enableCloudReplay: 1
enableRandomDuel: 1
enableMenu: 1

enableWindbot: 1
windbotEndpoint: ws://windbot:2399

enableSsl: 0
sslPath: ./ssl
```

### 4. 启动

```bash
docker compose pull
docker compose up -d
docker compose logs -f srvpro2
```

停止：

```bash
docker compose down
```

## 从本地内核版本升级

1. 备份现有 Compose、配置和镜像标识。等正在进行的比赛结束后再切换游戏服。
2. 增加上例的 Angelus 服务。默认镜像已含资源；有自定义资源时，把旧服务上相应的 CDB、`lflist.conf`、Lua、expansions 和 WASM 只读挂到 Angelus。其默认根目录为 `/app/ygopro`。配置多套资源时，在 Angelus 上设置 `YGOPRO_PATH` 并保留原来的搜索顺序，同时迁移 `EXTRA_SCRIPT_PATH`、`YGOPRO_RESOURCE_REFRESH_MINUTES`、`OCGCORE_WASM_PATH` 及对应路径。玩家数据、证书和数据库连接仍配置在 srvpro2。
3. 在 srvpro2 填写必需的 `ANGELUS_ENDPOINT`，例如 `http://angelus:3001`。容器间连接使用服务名。可填 HTTP(S) 或 WS(S) 基础地址，srvpro2 会保留路径前缀并派生三个资源 API 和 `/duel`。
4. 私有 Compose 网络可保持匿名。如果 Angelus 设置了 `SERVER_TOKEN`，在 srvpro2 设置相同的 `ANGELUS_TOKEN`，HTTP 请求和 WS 握手都会携带 `x-server-token`。
5. 人机建议使用支持 `GET /bots` 的 WindBot develop，保持 `WINDBOT_BOTLIST` 为空。打开列表或召唤时 srvpro2 都向 2399 取最新列表。若有自维护名单，单独挂载文件并指定 `WINDBOT_BOTLIST`。WindBot 服务启动时读取自己的 `bots.json`，替换其文件后重启 WindBot。
6. 启动后用客户端建房、交牌，并用 `AI#Burn` 加入人机房验证开局。Angelus 的 `GET /readyz` 用于检查资源就绪。TLS 在本示例里关闭，启用时把证书挂到 srvpro2 的 SSL 目录。

## Docker 镜像验收

在 srvpro2 仓库运行 `npm run test:docker-image`。脚本分别从当前仓库、`../ygoangelus` 和 `../ygopro/windbot` 构建镜像，使用独立网络与临时 PostgreSQL，WindBot 使用从 Angelus 提取的同一份 CDB。已有本地镜像可用 `SRVPRO_IMAGE`、`ANGELUS_IMAGE`、`WINDBOT_IMAGE` 指定。

验收覆盖两个独立机器人对战、服务端召唤人机和固定种子的人机悔棋。每盘检查终局、清房、原生 PostgreSQL 驱动、双方座次比分和非空录像数据。日志、镜像 ID 和数据库结果保存在 `output/docker-image-test/<run-id>/`。脚本清理本次创建的容器、网络、临时数据库和临时镜像。

## 配置怎么配（重点）

配置入口：

- `config.yaml`
- `docker-compose.yml` 的 `environment`

优先级：`environment > config.yaml > src/config.ts 默认值`

### 键名和类型规则

- `config.yaml` 建议使用 `camelCase`，如 `enableReconnect`
- 环境变量使用全大写下划线，如 `ENABLE_RECONNECT`
- 所有值最终都按字符串处理，开关建议统一写 `0` / `1`
- 数组可写 YAML 数组，或写成逗号分隔字符串

### 布尔值规则

- 默认值为 `0` 的项：`'' / 0 / false / null` 为关闭，其他都为开启
- 默认值为 `1` 的项：只有 `0 / false / null` 为关闭，其他都为开启

为避免歧义，推荐只用 `0` 和 `1`。

### 必配项建议

1. 网络端口
- `PORT` / `WS_PORT` / `API_PORT`

2. 数据库
- `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` / `DB_NAME`
- `DB_HOST` 留空则数据库功能关闭（云回放等会不可用）

3. Windbot
- `ENABLE_WINDBOT=1`
- `WINDBOT_ENDPOINT=ws://windbot:2399`

4. SSL
- `ENABLE_SSL=1`
- `sslPath` 指向证书目录，或配置 `SSL_CERT` + `SSL_KEY`

5. 常用功能开关
- `ENABLE_RECONNECT`
- `ENABLE_CLOUD_REPLAY`
- `ENABLE_RANDOM_DUEL`
- `ENABLE_ROOMLIST`
- `ENABLE_MENU`

### `menu` 示例（空密码菜单）

要启用空密码菜单，至少需要：

- `enableMenu: 1`（或 `ENABLE_MENU=1`）
- 在 `config.yaml` 里配置 `menu`

`menu` 的规则：

- 键是显示给玩家的文本
- 值为字符串时，表示对应的房间密码（会按该密码继续走加入逻辑）
- 值为对象时，表示子菜单
- 空对象 `{}` 常用于“返回上一层”

示例：

```yaml
menu:
  房间列表: L
  随机对战:
    单局: S
    比赛: M
    双打: T
    返回: {}
  人机对战:
    单局: S
    比赛: AI,M
    双打: AI,T
    返回: {}
  更多:
    云录像: R
    人机列表: B
    TCG匹配:
      单局: TOR
      比赛: TOMR
      返回: {}
    简体中文环境匹配:
      单局: CR
      比赛: CMR
      返回: {}
    观看随机对局录像: W
    返回: {}
```

## Docker Compose 使用建议

- 生产环境不要把密码和 token 直接写死在 `docker-compose.yml`，建议用 `.env` 或 secret 注入
- `ENABLE_CLOUD_REPLAY=1` 时建议确保 PostgreSQL 已正常连接

## 源码部署（可选）

```bash
npm ci
npm run gen:config-example
cp config.example.yaml config.yaml
npm run build
ANGELUS_ENDPOINT=http://localhost:3001 npm start
```

协议契约更新时，先在本机 3001 启动开启 Swagger 的 Angelus，再运行 `npm run gen:angelus-client`，检查并提交生成的 HTTP 客户端。日常构建直接使用仓库内的生成物。

## 参考文件

- 配置定义：`src/config.ts`
- 示例配置：`config.example.yaml`
- 镜像构建：`Dockerfile`
- 开发规范：`AGENTS.md`

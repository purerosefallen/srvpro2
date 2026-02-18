# SRVPro2

SRVPro2 是 SRVPro 的下一代项目：一个直接控制 `ocgcore`（WASM）的 YGOPro 服务器实现。  
它不再依赖“代理 ygopro 进程”的方案，而是用 TypeScript 在服务端直接管理对局、房间、扩展功能和重连流程。

## 推荐部署方式：Docker Compose

优先使用镜像：

`git-registry.moenext.com/nanahira/srvpro2`

下面给一个简化版单服示例：`windbot + postgres + srvpro2`，主服端口 `7911`。

### 1. 准备目录

```bash
mkdir -p srvpro2/{data,ssl,postgres}
cd srvpro2
```

### 2. 创建 `docker-compose.yml`

```yaml
version: "2.4"
services:
  windbot:
    restart: always
    image: git-registry.moenext.com/nanahira/windbot:master
    ports:
      - "12399:2399"

  postgres:
    restart: always
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: srvpro
      POSTGRES_PASSWORD: CHANGE_ME_DB_PASS
      POSTGRES_DB: srvpro2
    volumes:
      - ./postgres:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  srvpro2:
    restart: always
    image: git-registry.moenext.com/nanahira/srvpro2:latest
    depends_on:
      - windbot
      - postgres
    ports:
      - "7911:7911"
      - "7912:7912"
      - "7922:7922"
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - ./config.yaml:/usr/src/app/config.yaml:ro
      - ./ssl:/usr/src/app/ssl:ro
      - ./data:/usr/src/app/data
      # 如需使用自定义游戏资源可取消注释
      # - ./ygopro:/usr/src/app/ygopro:ro
    environment:
      TZ: Asia/Shanghai
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_USER: srvpro
      DB_PASS: CHANGE_ME_DB_PASS
      DB_NAME: srvpro2
      PORT: "7911"
      WS_PORT: "7912"
      API_PORT: "7922"
      ENABLE_SSL: "1"
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
ygoproPath: ./ygopro

enableReconnect: 1
enableRoomlist: 1
enableCloudReplay: 1
enableRandomDuel: 1
enableMenu: 1

enableWindbot: 1
windbotEndpoint: ws://windbot:2399

enableSsl: 1
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
npm install
npm run gen:config-example
cp config.example.yaml config.yaml
npm run build
npm start
```

## 参考文件

- 配置定义：`src/config.ts`
- 示例配置：`config.example.yaml`
- 镜像构建：`Dockerfile`
- 开发规范：`AGENTS.md`

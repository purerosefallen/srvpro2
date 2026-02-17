# 项目情况

本项目是 SRVPro（YGOPro 服务器）项目的下一代项目。

## 项目规范

- 禁止在模块里面保存 `Client` 或者 `Room` 的强引用（包括 `Map` key/value、闭包长期持有等）。如需关联状态，优先使用 `pos`、`room.name` 等轻量标识。
- 禁止直接在 `Client` 和 `Room` 类里面添加耦合业务模块的字段或者方法。需要扩展时可通过定义 interface 做依赖合并；若扩展房间流程，允许在 `Room` 里新增并 `dispatch` 专用事件。
- 进行协议设计需要核对 ygopro 和 srvpro 的 coffee 和 cpp 的实现。
- 尽量定义新的模块实现功能，而不是在之前的方法上进行修改。
- 配置在 config.ts 里面写默认类型。注意所有类型必须是 string 并且全部大写字母。改了之后需要 npm run gen:config-example 生成 config.example.yaml
- 如果 Room 的事件不够，可以加，然后在对应的点加 dispatch。
- Room 的事件不要依赖 YGOProMsgStart 或者 YGOProMsgWin 这样的直接消息事件（经常会不准，这些事件只适合用来构建 replay），应该依赖 Room 专用事件。
- 定义 middleware 如果不是拦截消息，必须 return next()
- 引用规范：
  - 目录内引用：同级文件使用 `'./xxx'`，子目录文件使用 `'../xxx'`
  - 目录外引用：必须通过 index.ts 引用，如 `'../room'` `'../client'`（指向 index.ts）
  - 禁止直接引用具体文件：不要使用 `'../room/room'` `'../client/client'` 这样的路径
- 如果正在写的算法代码与 this 和业务无关，那么不要放在类方法里面，而是在 utility 目录新开一个 ts 文件放进去
- 如果正在移植 srvpro 的功能，那么 i18n 必须严格和 srvpro 保持一致，不能改动 i18n 的 key 和 value。新功能或者原有功能的额外部分可以写新的。

## 模块结构

- 客户端收发相关：TransportModule
- 额外功能相关：FeatsModule（所有的本来 srvpro 处理的各种额外功能都放在这里。日后做的扩展都在这里）
- 房间核心相关：RoomModule（用来复刻 ygopro 功能）
- 加入相关：JoinHandlerModule（专门用来处理 YGOProCtosJoinGame 用来分配房间，比如房间或者随机对战什么的）

## 部分实现细节

### 和 srvpro 的对应关系

本项目是一个直接操作 ocgcore 的项目，而 srvpro 是依靠『把自己夹在客户端和 server 之间』来工作的。因此某些实现方式要调整。

- srvpro 里面的 client.send（发送给客户端）还是对应 client.send
- srvpro 里面 server.send（模拟客户端发送消息）对应 this.ctx.dispatch(msgClassInstance, client)

## ts-rest 相关（如果用到的话）

- 契约文件放在 src/api/contract.ts 一个文件里面，方便其他项目复制。

## TypeORM 相关

- 删除一律用 softDelete。

## 参考项目

可以参考电脑的下面的项目，用来参考。这些代码只能看，不能改。~ 指代这台电脑的 HOME 目录。

- ygopro-msg-encode（js 协议库）: ~/ygo/ygopro-msg-encode
- koishipro-core.js（wasm 层）: ~/ygo/koishipro-core.js
- ocgcore（YGOPro ocgcore 内核）: ~/ygo/ygopro/ocgcore
- ygopro（YGOPro 主程序服务端）: ~/ygo/ygopro/gframe
- srvpro（本项目的上一代）: ~/ygo/srvpro-koishi
- yuzuthread（多线程执行器）: ~/test/yuzuthread
- typed-reflector（反射器）: ~/test/koishi-related/typed-reflector
- nfkit（工具库,事件触发器，IoC）: ~/test/nfkit

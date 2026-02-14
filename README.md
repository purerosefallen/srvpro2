# SRVPro2

> Next-generation YGOPro server with direct ocgcore control

SRVPro2 is the modern successor to SRVPro, implementing a complete YGOPro server in TypeScript with direct ocgcore (WebAssembly) control, modular architecture, and advanced features like disconnect/reconnect support.

## ✨ Features

- 🎮 **Direct ocgcore Control** - Uses WebAssembly (koishipro-core.js) to directly interact with ocgcore instead of proxying through ygopro
- 🔄 **Advanced Reconnect System** - Two-stage reconnect with deck verification and complete state reconstruction
- 🧵 **Multi-threaded Architecture** - Each room runs in an isolated Worker thread for better performance and crash isolation
- 🏗️ **Modular Design** - Clean separation of concerns with TransportModule, RoomModule, FeatsModule, and JoinHandlerModule
- 📦 **Full Protocol Support** - Complete implementation of YGOPro network protocol via ygopro-msg-encode
- 🔧 **Extensible** - Easy to add new features through middleware and module system

## 🏛️ Architecture

### Core Differences from SRVPro

| Aspect | SRVPro (v1) | SRVPro2 (v2) |
|--------|-------------|--------------|
| **Architecture** | Network proxy | Direct control |
| **ocgcore Access** | Indirect (via ygopro subprocess) | Direct (via WASM) |
| **Process Model** | Multi-process (Node.js + ygopro) | Single-process multi-threaded |
| **Communication** | TCP/IP networking | In-memory message passing |
| **State Query** | Message inference only | Full query API available |
| **Reconnect** | Simple (swap connections) | Advanced (state reconstruction) |

### Architecture Diagram

```
┌──────────────────────────────────────────────┐
│  SRVPro2 (Node.js Process)                   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  Main Thread                         │   │
│  │  - Network I/O (WebSocket)           │   │
│  │  - Room Management                   │   │
│  │  - Client Handling                   │   │
│  └──────────┬───────────────────────────┘   │
│             │                                │
│  ┌──────────┴───────────┬──────────────┐   │
│  │ Worker Thread 1      │ Worker 2     │   │
│  │ (Room A)             │ (Room B)     │   │
│  │ ┌────────────────┐   │ ┌──────────┐ │   │
│  │ │ ocgcore.wasm   │   │ │ ocgcore  │ │   │
│  │ │ (Game Engine)  │   │ │  ...     │ │   │
│  │ └────────────────┘   │ └──────────┘ │   │
│  └──────────────────────┴──────────────┘   │
└──────────────────────────────────────────────┘
```

### Module Structure

- **TransportModule**: WebSocket transport and client connection management
- **RoomModule**: Core game room logic (replicating ygopro functionality)
- **FeatsModule**: Extended features (welcome messages, reconnect, player status notifications, etc.)
- **JoinHandlerModule**: Room joining and matchmaking logic

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ (for Worker threads support)
- TypeScript 5.x
- YGOPro game resources (scripts, databases)

### Installation

```bash
npm install
```

### Configuration

1. Generate configuration template:
```bash
npm run gen:config-example
```

2. Copy and edit the configuration:
```bash
cp config.example.yaml config.yaml
# Edit config.yaml with your settings
```

### Build and Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## 🔧 Configuration

Configuration meaning source of truth:

- `src/config.ts` is the canonical place for all config keys and their meanings.
- Use the comments in `src/config.ts` to understand what each field does.
- `config.example.yaml` is generated from `src/config.ts` defaults for quick editing.
- All config values are loaded as strings; follow each field's format note in `src/config.ts`.
- Format examples used in `src/config.ts`: comma-separated lists, integer strings, and explicit time units (`ms` or `s`).

Commonly used options:

- `WELCOME`: Welcome message shown to players joining rooms
- `RECONNECT_TIMEOUT`: Disconnect timeout before reconnect expires (default: 180000ms)
- `ENABLE_RECONNECT`: Reconnect feature switch (default enabled)
- Standard YGOPro settings (port, timeout, banlist, etc.)

After modifying defaults in `src/config.ts`, regenerate the example config:
```bash
npm run gen:config-example
```

## 📚 Key Features

### Disconnect/Reconnect System

Unlike SRVPro's connection-swap approach, SRVPro2 implements a sophisticated two-stage reconnect:

1. **Pre-reconnect**: Client enters room lobby, verifies deck
2. **Full reconnect**: Complete game state reconstruction using ocgcore query APIs

The system supports both passive reconnect (network loss) and kick reconnect (logging in from another device).

### Direct State Query

Because SRVPro2 controls ocgcore directly, it can query any game state at any time:

```typescript
// Query complete field state
const field = await room.ocgcore.queryFieldInfo();
const player0LP = field.field.lp0;

// Query specific card
const card = await room.ocgcore.queryCard({
  player: 0,
  location: LOCATION_MZONE,
  sequence: 0,
  queryFlag: QUERY_ATTACK | QUERY_DEFENSE
});
```

This enables features impossible in proxy-based architectures.

## 🛠️ Development

### Project Structure

```
src/
├── client/          # Client connection handling
├── feats/           # Extended features (welcome, reconnect, etc.)
├── join-handlers/   # Room joining logic
├── room/            # Core room and game logic
├── transport/       # WebSocket transport
├── ocgcore-worker/  # Worker thread for ocgcore
├── utility/         # Helper functions
└── config.ts        # Configuration definitions
```

### Coding Guidelines

See [AGENTS.md](./AGENTS.md) for detailed development guidelines, including:

- Module organization principles
- Import/export conventions
- Middleware patterns
- Event handling best practices

### Adding New Features

New features should be implemented as modules in `FeatsModule`:

```typescript
// src/feats/my-feature.ts
export class MyFeature {
  constructor(private ctx: Context) {
    // Register middleware
    this.ctx.middleware(SomeEvent, async (event, client, next) => {
      // Your logic
      return next();
    });
  }
}

// src/feats/feats-module.ts
export const FeatsModule = createAppContext<ContextState>()
  .provide(MyFeature)  // Add your module
  .define();
```

## 🤝 Contributing

Contributions are welcome. When contributing:

1. Follow the coding guidelines in AGENTS.md
2. Test your changes thoroughly
3. Update documentation as needed
4. Ensure `npm run build` completes successfully

## 📄 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- **YGOPro Team** - Original game engine and protocol
- **SRVPro** - Foundation and inspiration for this project
- **koishipro-core.js** - WASM wrapper for ocgcore
- **nfkit** - IoC container and event system
- **yuzuthread** - Worker thread management

## 📖 Related Projects

- [ygopro](https://github.com/Fluorohydride/ygopro) - Original YGOPro server
- [koishipro-core.js](https://github.com/purerosefallen/koishipro-core.js) - WASM ocgcore wrapper
- [ygopro-msg-encode](https://github.com/purerosefallen/ygopro-msg-encode) - YGOPro protocol library

---

**SRVPro2** - Built with ❤️ by Nanahira

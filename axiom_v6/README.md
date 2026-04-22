# AXIOM v6 — East Africa Edition Web IDE

<p align="center">
  <img src="public/axiom-logo.png" alt="AXIOM IDE Logo" width="120" />
</p>

<p align="center">
  <strong>A full-featured, browser-based IDE built for developers in East Africa and beyond.</strong><br>
  Real terminal · AI pair programming · Git integration · LSP intelligence · DAP debugging · Collaborative editing · M-Pesa billing
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-6.0.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/database-MySQL%208-orange" alt="MySQL" />
</p>

---

## Features

### Code Editor
- Syntax highlighting for 20+ languages with semantic tokens from LSP
- Multiple file tabs with unsaved-change indicators
- Virtual scrolling for large files (viewport-based rendering)
- Minimap navigation, find & replace, bracket matching, auto-closing
- Side-by-side visual diff editor with LCS-based algorithm

### Integrated Terminal
- Full PTY-backed terminal via **node-pty** and **xterm.js**
- Multiple terminal sessions with tab management
- Clickable links, auto-resize, profile switching

### AI Pair Programming
- Powered by **Anthropic Claude** (Claude Sonnet / Claude 4)
- Context-aware code assistance with persistent memory engine
- AI diff preview: review proposed changes as side-by-side diffs before applying
- Token usage tracking per user

### Git Integration
- Visual status, diff, staging, commit, push, pull, branch management
- Git blame, timeline, cherry-pick, rebase, tags, submodules
- Merge conflict resolution UI

### Debugging (DAP)
- Real **Debug Adapter Protocol** integration
- Python (debugpy), Go (delve), Node.js (--inspect)
- Breakpoints, stepping, variable inspection, watch expressions, call stack

### Language Intelligence (LSP)
- Full **Language Server Protocol** client
- Autocomplete, hover, go-to-definition, find references, rename
- Real-time diagnostics, code formatting, code actions, semantic tokens
- Supported: Pyright, typescript-language-server, gopls, rust-analyzer, clangd

### Collaboration
- Real-time collaborative editing via WebSocket rooms
- Operational Transform for conflict resolution
- Live cursor tracking, persistent session state

### Extensions
- Plugin system with activation/deactivation
- Extension marketplace UI for discovery and install

### Themes
- 20+ built-in themes including East African-inspired themes:
  Savanna Sunrise, Kilimanjaro Night, Maasai Red, Zanzibar Ocean, and more
- Classic: Monokai, Dracula, Solarized, One Dark, Nord, Tokyo Night

### Billing & Subscriptions
- Four tiers: Free, Starter ($9/mo), Pro ($19/mo), Team ($49/mo)
- **M-Pesa** payment integration (KES pricing)
- Admin analytics dashboard

### Authentication
- GitHub OAuth, Google OAuth, email/password
- Role-based access control (user / admin)
- JWT sessions with secure token management

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 18.0+ | v20 LTS recommended |
| **npm** | 9.0+ | Comes with Node.js |
| **MySQL** | 8.0+ | Or MariaDB 10.6+ |
| **Python 3** | 3.8+ | Required for building `node-pty` |
| **C++ compiler** | GCC/Clang | `build-essential` on Debian/Ubuntu |

### Optional (for LSP / DAP)

| Tool | Install | For |
|---|---|---|
| Pyright | `npm i -g pyright` | Python LSP |
| typescript-language-server | `npm i -g typescript-language-server typescript` | JS/TS LSP |
| gopls | `go install golang.org/x/tools/gopls@latest` | Go LSP |
| debugpy | `pip install debugpy` | Python debugging |
| delve | `go install github.com/go-delve/delve/cmd/dlv@latest` | Go debugging |

---

## Installation

```bash
git clone https://github.com/your-org/axiom-ide.git
cd axiom-ide
npm install

# Set up MySQL
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS axiom CHARACTER SET utf8mb4;"

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Run migrations
npm run migrate

# Start
npm start
```

Open [http://localhost:5000](http://localhost:5000)

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | HTTP server port |
| `NODE_ENV` | `development` | `development` or `production` |
| `DB_HOST` | `localhost` | MySQL host |
| `DB_USER` | `root` | MySQL username |
| `DB_PASS` | _(required in prod)_ | MySQL password |
| `DB_NAME` | `axiom` | MySQL database name |
| `GITHUB_CLIENT_ID` | | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | | GitHub OAuth app secret |
| `GOOGLE_CLIENT_ID` | | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | | Google OAuth client secret |
| `ANTHROPIC_API_KEY` | | Anthropic API key for Claude AI |

---

## Docker

```bash
cp .env.example .env  # configure
docker compose up -d
docker compose exec axiom npm run migrate
```

---

## Architecture

```
axiom_v6/
├── src/server.js          # Main server (HTTP, WebSocket, API)
├── public/
│   ├── index.html         # IDE frontend (SPA)
│   ├── admin.html         # Admin dashboard
│   └── xterm/             # Terminal emulator assets
├── migrations/            # SQL schema migrations
├── scripts/migrate.js     # Migration runner
├── tests/                 # Test suite
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/name`
3. Commit: `git commit -m "feat: description"`
4. Push and open a Pull Request

We follow [Conventional Commits](https://www.conventionalcommits.org/).

---

## License

MIT License - see [LICENSE](LICENSE)

Built with purpose for the East African developer community.
**AXIOM** — Your code, your way.

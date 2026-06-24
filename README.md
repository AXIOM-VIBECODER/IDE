# IDE
<div align="center">
  <img src="public/axiom-logo.png" alt="AXIOM IDE" width="100"/>

```
╔══════════════════════════════════════════════════════════════╗
║              A X I O M  v6 — East Africa Edition            ║
║      The AI Software Engineer · Built in East Africa        ║
╚══════════════════════════════════════════════════════════════╝
```

# AXIOM IDE v6

**A full-featured, AI-powered browser IDE built for East African developers.**
Monaco editor · Real terminal · Git · LSP · Multi-AI Orchestra · M-Pesa · USSD · Swahili AI · PWA

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/Electron-30-blue?style=flat-square&logo=electron)](https://www.electronjs.org)
[![PWA](https://img.shields.io/badge/PWA-installable-purple?style=flat-square)](https://web.dev/progressive-web-apps/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![East Africa](https://img.shields.io/badge/Built%20for-East%20Africa-orange?style=flat-square)](https://github.com/AXIOM-VIBECODER/IDE)

</div>

---

## What is AXIOM?

AXIOM is a zero-dependency, self-hosted IDE that runs entirely in your browser — no VS Code, no cloud subscription, no Electron required to start coding. It combines:

- A **Monaco editor** (the same engine as VS Code) with split panes and per-file models
- A **real PTY terminal** — not a fake web console, a real bash/zsh shell
- A **3-agent AI Orchestra** where each agent specializes in a different role
- **East Africa-first** integrations: M-Pesa STK Push, USSD flow builder, Africa's Talking SMS/Airtime, Swahili/Sheng AI
- Full **PWA support** — install it on your phone or desktop from any browser

---

## The IDE

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AXIOM IDE v6   ▣  ⌘P   ──────────────────  🎼  Cascade  ⚙  [●] [■]  │
├───────┬─────────────────────────────────────────┬───────────────────────┤
│       │  server.js  ×    mpesa.js  ×            │  AI Cascade           │
│  📁   │ ──────────────────────────────────────  │  ───────────────────  │
│  src/ │  1  const express = require('express')  │  > Build an M-Pesa   │
│  pub/ │  2  const { stkPush } = require(...)    │    payment route      │
│       │  3                                       │                       │
│  🔍   │  4  app.post('/pay', async (req, res)=> │  Here's the route    │
│       │  5    const result = await stkPush({     │  with full error      │
│  🌿   │  6      phone: req.body.phone,           │  handling...          │
│       │  7      amount: req.body.amount          │                       │
│  🎼   │  8    })                                 │  ```javascript        │
│       │  9    res.json(result)                   │  app.post('/pay',..   │
│  💳   │ 10  })                                   │  ```                  │
│       │ ──────────────────────────────────────  │                       │
│  ⚙️   │  TERMINAL  +                             │  [Insert]  [Copy]     │
│       │  $ node server.js                        │                       │
│       │  ✓ Server on http://localhost:3000       │                       │
└───────┴─────────────────────────────────────────┴───────────────────────┘
```

---

## AI Orchestra — 3 Agents, 1 Pipeline

The 🎼 button in the toolbar launches the Orchestra. Three agents work in sequence, each with its own model:

```
You type: "Build a REST API for M-Pesa payments with Express and MySQL"
                              │
              ┌───────────────▼────────────────┐
              │  🏗  ARCHITECT                  │
              │  claude-opus-4-8               │
              │                                │
              │  Plans: routes, DB schema,     │
              │  middleware, error handling     │
              └───────────────┬────────────────┘
                              │ architecture plan
              ┌───────────────▼────────────────┐
              │  ⌨️  CODER                      │
              │  qwen2.5-coder:7b (Ollama)     │  ← can be local/free
              │                                │
              │  Writes the full implementation│
              │  based on the architect's plan │
              └───────────────┬────────────────┘
                              │ code
              ┌───────────────▼────────────────┐
              │  📝  DOCUMENTER                 │
              │  claude-haiku-4-5-20251001     │  ← fast and cheap
              │                                │
              │  JSDoc, usage examples,        │
              │  API reference table           │
              └───────────────┬────────────────┘
                              │
                    [Insert Code]  [Open as New File]
```

Each role is **independently configurable** — mix Anthropic Claude, Ollama, or LM Studio per agent. In Settings → AI Orchestra you can assign any model to any role.

---

## Orchestra Output

```
┌─────────────────────── AI Orchestra ──────────────────────────────────┐
│  Task: Build a REST API for M-Pesa payments            [streaming...]  │
│                                                                        │
│  🏗  Architect    ✓ Done                                  [▲ collapse] │
│  ──────────────────────────────────────────────────────────────────── │
│  Routes:                                                               │
│   POST /mpesa/stk-push   — initiate STK Push                          │
│   POST /mpesa/callback   — handle Safaricom callback                  │
│   GET  /mpesa/status/:id — poll transaction                           │
│  Schema: mpesa_transactions(id, checkoutRequestId, phone,             │
│          amount, status, mpesaRef, created_at)                        │
│                                                                        │
│  ⌨️   Coder       ✓ Done                                  [▲ collapse] │
│  ──────────────────────────────────────────────────────────────────── │
│  const express = require('express');                                   │
│  const mysql = require('mysql2/promise');                             │
│  ...complete implementation...                                        │
│                                                                        │
│  📝  Documenter   ✓ Done                                               │
│  ──────────────────────────────────────────────────────────────────── │
│  ## M-Pesa Payment API                                                 │
│  | Route | Method | Body | Returns |                                  │
│  |-------|--------|------|---------|                                   │
│  | /mpesa/stk-push | POST | {phone, amount} | {CheckoutRequestID} |  │
│                                                                        │
│  [Insert Code into Editor]          [Open as New File]                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## East Africa Features

### 💳 M-Pesa STK Push
One click inserts a complete, production-ready STK Push snippet — Daraja API, token refresh, callback handler — for Node.js or Python.

```javascript
// Generated by AXIOM East Africa Tools
const result = await stkPush({
  phone: '254712345678',
  amount: 100,
  accountRef: 'Order001'
});
```

### 📟 USSD Builder
Visual drag-and-drop USSD flow editor. Add screens, set options, wire transitions — then generate working Express or Python code for Africa's Talking.

```
Screen 1: "Welcome\n1. Balance\n2. Send\n0. Exit"
   ├── 1 → Screen 2: "Balance: KES {bal}\n0. Back"
   ├── 2 → Screen 3: "Enter phone:"  [text input]
   └── 0 → End
```
Click **Generate Code** → complete USSD server code ready to deploy.

### 📱 SMS & Airtime (Africa's Talking)
Ready-to-run snippets for sending SMS and Airtime top-ups across Kenya, Uganda, Tanzania, Rwanda, and Ethiopia.

### 🗣 Swahili / Sheng AI
Ask the AI in Kiswahili or Sheng — it responds naturally and writes code with culturally relevant examples.
> *"Tengeneza API ya kulipa kwa M-Pesa"* → full M-Pesa API implementation

### 🚀 One-Click Deploy
Pre-wired deploy commands for Railway, Render, Fly.io, and Vercel — sent directly to the integrated terminal.

---

## Features at a Glance

| Category | Features |
|---|---|
| **Editor** | Monaco engine, split panes, multi-cursor, minimap, bracket match, auto-indent |
| **Terminal** | Real PTY (bash/zsh), multiple tabs, resize, colors, history |
| **Git** | Status, side-by-side diff, blame gutter, stage/unstage/commit/push/pull |
| **LSP** | Python (Pyright), JS/TS (tsserver), Go (gopls), Rust (rust-analyzer), C/C++ (clangd) |
| **Debugger** | DAP breakpoints, step through, variable watch — Node.js & Python |
| **AI Chat** | Streaming Cascade chat with file context and memory |
| **AI Orchestra** | 3-agent pipeline: Architect + Coder + Documenter |
| **AI Edit** | Inline rewrite, refactor, extract function, cleanup |
| **AI Analyze** | Explain code, find bugs, security scan |
| **Snippets** | Custom snippet library with language filter |
| **DB Panel** | MySQL query runner, connection manager |
| **Search** | Full Find & Replace with regex, case, word, glob patterns |
| **Themes** | 10 themes including Savanna Sunset, Kilimanjaro, Maasai Red, Indian Ocean |
| **PWA** | Installable on any device, offline shell cache, install prompt in status bar |

---

## Install & Run

### Option 1 — Browser (fastest)

```bash
git clone https://github.com/AXIOM-VIBECODER/IDE.git
cd IDE/axiom_v6
npm install
npm start
```

Open **http://localhost:5000** in Chrome, Edge, Firefox, or Safari.

To install as a native app: click the **⬇ Install App** button in the status bar (Chrome/Edge), or use Safari's Share → Add to Home Screen (iOS).

### Option 2 — Electron Desktop

```bash
npm run electron        # development
npm run build:win       # Windows .exe installer
npm run build:linux     # Linux .AppImage / .deb / .rpm
npm run build:mac       # macOS .dmg (Intel + Apple Silicon)
npm run build:all       # all platforms at once
```

### Option 3 — Offline AI with Ollama

```bash
# Install Ollama (free, runs locally, works offline)
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a coding model
ollama pull qwen2.5-coder:7b      # 4 GB, fast
ollama pull codestral:22b          # 12 GB, powerful

# In AXIOM: Settings → AI Provider → Ollama → Save
# Or assign it to just the Coder role in Settings → AI Orchestra
```

---

## Configuration

Everything lives in `~/.axiom/` — nothing touches the repo.

| File | Purpose |
|---|---|
| `~/.axiom/key` | Anthropic API key (encrypted at rest) |
| `~/.axiom/ai_provider.json` | Default provider (Anthropic / Ollama / LM Studio) |
| `~/.axiom/ai_orchestra.json` | Per-role model config for the Orchestra |
| `~/.axiom/config.json` | Auth token, user preferences |
| `~/.axiom/memory.json` | AI long-term memory facts |
| `~/.axiom/snippets.json` | Custom code snippets library |

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Command Palette | `Ctrl+Shift+P` |
| File Picker | `Ctrl+P` |
| AI Orchestra | `🎼` toolbar button |
| Toggle AI Chat | `Ctrl+Shift+A` |
| Toggle Terminal | `` Ctrl+` `` |
| Split Editor | `Ctrl+\` |
| Format Document | `Shift+Alt+F` |
| Go to Definition | `F12` |
| Find in Files | `Ctrl+Shift+F` |
| Git Panel | `Ctrl+Shift+G` |
| Recent Workspaces | `Ctrl+R` |
| Save | `Ctrl+S` |

---

## Architecture

```
axiom_v6/
├── src/server.js          Single-file Node.js backend (~3,800 lines)
│   ├── LSP client         Talks to pyright, tsserver, gopls, rust-analyzer, clangd
│   ├── DAP debugger       Debug Adapter Protocol for Node.js + Python
│   ├── WebSocket PTY      Real terminal via node-pty
│   ├── AI Orchestra       aiCallRole() — per-role provider dispatch
│   ├── aiCall / aiStream  Unified helpers → Anthropic or OpenAI-compat (Ollama/LM Studio)
│   ├── Git routes         status, diff, blame, stage, commit, push, pull
│   ├── M-Pesa routes      STK Push, callback, transaction log
│   └── Static server      Serves public/ with correct MIME + SW headers
│
├── public/index.html      Entire frontend (~17,800 lines)
│   ├── Monaco editor      Split panes, per-file models, themes
│   ├── AI Orchestra UI    Streaming 3-agent output panel
│   ├── EA tools           M-Pesa, USSD builder, SMS/Airtime, Swahili prompt, Deploy
│   ├── Settings           Provider / model / orchestra config per role
│   └── PWA shell          Service worker registration, install prompt
│
├── public/manifest.json   PWA manifest (icons, shortcuts, display: standalone)
├── public/sw.js           Service worker — caches shell, network-first nav
├── public/icons/          SVG icon (scales to all sizes)
│
├── electron/main.js       Electron entry — spawns server, BrowserWindow
├── electron/preload.js    Context bridge for IPC
└── package.json           electron-builder config for Win / Linux / Mac
```

---

## License

MIT — free to use, modify, and ship.

---

<div align="center">

**Built with ❤️ in East Africa**

*For the developer in Nairobi writing their first API.*
*For the engineer in Kampala building on mobile data.*
*For the founder in Dar es Salaam shipping their MVP.*

[GitHub](https://github.com/AXIOM-VIBECODER/IDE) · [Issues](https://github.com/AXIOM-VIBECODER/IDE/issues) · [Discussions](https://github.com/AXIOM-VIBECODER/IDE/discussions)

</div>

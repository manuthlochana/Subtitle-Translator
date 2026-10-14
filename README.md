# Sinhala Subtitle Studio (Frame/Text)

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react)
![Vite](https://img.shields.io/badge/Vite-7-646cff?logo=vite)
![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v4-38bdf8?logo=tailwindcss)
![Google Gemini](https://img.shields.io/badge/Google%20Gemini-Multi--Model-8e75ff?logo=google)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)
![License](https://img.shields.io/badge/License-MIT-green)

> **Enterprise-grade English-to-Sinhala SRT localization engine featuring 100% natural colloquial speech and a proprietary 3-Layer Unicode Defense System.**

---

## 🌟 Key Innovations & Features

### 1. 🛡️ 3-Layer Unicode Defense System
Previous automated subtitle translations suffered from cross-lingual script bleeding (injecting Tamil, Telugu, Bengali, Malayalam, Kannada, Devanagari, Georgian, Burmese, or Amharic characters) and parenthetical translation notes. Sinhala Subtitle Studio deploys a 3-layer safeguard:
* **Layer 1 — Native Screenwriter Prompting:** System instructions tuned specifically for authentic, spoken Sri Lankan Sinhala (`කතා කරන ස්වභාවික සිංහල`). Eliminates robotic "Google Translate" phrasing, transliterates common English loanwords into Sinhala Unicode directly (e.g., `ප්රැක්ටිස්`, `සීරියස්`), and strictly forbids foreign scripts.
* **Layer 2 — Post-Processing Sanitizer & Script Validator:** Real-time character-level regex analysis scanning every response block before acceptance. Rejects foreign Unicode ranges and strips parenthetical hallucinations.
* **Layer 3 — Auto-Heal Micro-Retries & Rolling Context:** Any corrupted or missing blocks are automatically re-requested using an isolated repair instruction. For chunked mode, the last 5 translated blocks are supplied as read-only context to preserve character gender, pronouns (`ඔයා/උඹ/තමුසේ/එයා`), and ongoing jokes across chunk boundaries.

### 2. ⚡ Gemini Multi-Model Registry & Smart Execution Engine
Supports 7 Google Gemini models with intelligent tiering, rate limit pacing, and automatic fallback chains:

| Tier | Model | Strategy | Limits | Recommended Use |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1 (High-Volume)** | `gemini-3.5-flash-lite` | Chunked Batches (80–100 cues) | 500 RPD \| 15 RPM \| 250K TPM | **Default / Overall #1** for stable daily runs with natural rhythm |
| **Tier 1 (High-Volume)** | `gemini-3.1-flash-lite` | Chunked Batches (80–100 cues) | 500 RPD \| 15 RPM \| 250K TPM | High-volume official backup |
| **Tier 2 (Ultra-Quality)** | `gemini-3.8-flash` | Full-SRT Single Pass (400–600 cues) | 20 RPD \| 5 RPM \| 250K TPM | **#1 Top Linguistic Quality**; preserves 100% episode context & adult humor |
| **Tier 2 (Ultra-Quality)** | `gemini-3.7-flash` | Full-SRT Single Pass (400–600 cues) | 20 RPD \| 5 RPM \| 250K TPM | Primary high-quality backup |
| **Tier 2 (Ultra-Quality)** | `gemini-3.6-flash` / `gemini-3-flash` | Full-SRT Single Pass (400–600 cues) | 20 RPD \| 5 RPM \| 250K TPM | Secondary Gen-3 fallbacks |
| **Tier 3 (Legacy)** | `gemini-2.5-flash-lite` / `gemini-2.5-flash` | Full-SRT Single Pass | 20 RPD \| 5–10 RPM \| 250K TPM | Legacy models (literal tone) |

* **Automatic Fallback Routing:** If `gemini-3.8-flash` exhausts its daily 20 RPD or encounters quota errors, it falls back seamlessly: `3.8 Flash` $\rightarrow$ `3.7 Flash` $\rightarrow$ `3.6 Flash` $\rightarrow$ `3.5 Flash Lite` (auto-transitioning to 80–100 chunk mode).
* **Adaptive Rate Limiter:** Enforces 4.5s pacing for 15 RPM models and 12.5s pacing for 5 RPM models with exponential backoff on HTTP `429` / `503`.

### 3. ⏱️ 100% SRT Timing & Structure Integrity
* Subtitle numbers and millisecond timestamps (`00:00:00,000 --> 00:00:00,000`) are locked by backend code.
* Preserves HTML tags (`<i>`, `</i>`) and music cues (`♪`).
* **UTF-8 with BOM Export:** Generates clean `.srt` files encoded in UTF-8 with BOM (`\uFEFF`) and CRLF line endings, guaranteeing crisp font rendering on Windows/macOS media players (VLC, IINA, MPC-HC, PotPlayer).

---

## 🏛️ System Architecture

```
[ User Browser / Client UI ]
           │
           │  Upload SRT + Gemini API Key
           ▼
[ Express.js API Server (Port 3000) ]
   ├── SRT Parser & Serializer (Preserves Timecodes & Indices)
   ├── Multi-Model Router & Rate Limiter (Token Bucket + RPD Tracker)
   ├── Translation Engine (Smart Chunker: 80-100 vs Full-Pass)
   └── 3-Layer Defense:
        ├── Layer 1: Native Screenwriter System Instructions
        ├── Layer 2: Regex Unicode Validator & Sanitizer
        └── Layer 3: Auto-Heal Micro-Retry + Rolling Context
           │
           ▼
[ Google Gemini Generative AI API (REST v1beta) ]
```

### Repository Structure
```
.
├── artifacts/
│   ├── api-server/              # Backend translation engine & Express API
│   │   ├── src/
│   │   │   ├── translator/      # Core logic (engine, chunker, models, sanitizer, srt)
│   │   │   ├── routes/          # REST endpoints (/api/translate/...)
│   │   │   ├── app.ts           # Express setup + static SPA serving
│   │   │   └── index.ts         # Server bootstrapper
│   │   └── ecosystem.config.cjs # Production PM2 cluster configuration
│   └── subtitle-translator/     # Frontend SPA (React + TailwindCSS + Vite)
│       └── src/
│           ├── App.tsx          # Real-time studio dashboard & quality monitor
│           └── index.css        # Studio design system & badges
├── lib/                         # Shared workspace modules (types, schemas, DB)
├── package.json                 # Monorepo root script orchestration
├── pnpm-workspace.yaml          # Monorepo configuration & package management
└── .env.example                 # Environment variable template
```

---

## 🚀 Getting Started

### Prerequisites
* **Node.js**: v20.x or higher
* **pnpm**: v9.x or higher
* **Google Gemini API Key**: Obtainable from [Google AI Studio](https://aistudio.google.com/)

### Installation & Local Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/manuthlochana/Subtitle-Translator.git
   cd Subtitle-Translator
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Configure Environment:**
   Create an `.env` file in `artifacts/api-server/`:
   ```bash
   cp .env.example artifacts/api-server/.env
   ```

4. **Run Development Servers:**
   ```bash
   # Run Backend API
   pnpm --filter @workspace/api-server run dev

   # Run Frontend UI (in another terminal)
   pnpm --filter @workspace/subtitle-translator run dev
   ```

5. **Typecheck & Production Build:**
   ```bash
   # Typecheck entire workspace
   pnpm run typecheck

   # Build both backend and frontend artifacts
   pnpm run build
   ```

---

## 🌐 Production Deployment (Ubuntu EC2 + PM2)

1. **Start application with PM2:**
   ```bash
   cd artifacts/api-server
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   ```

2. **Verify live server status:**
   ```bash
   pm2 status
   curl http://localhost:3000/api/healthz
   ```

---

## 🔒 Enabling HTTPS & Domain (Nginx + Let's Encrypt)

To secure your production deployment with an SSL certificate:

### 1. Point Your Domain DNS
Add an **A Record** in your DNS provider (Cloudflare, Namecheap, Route 53):
* **Host:** `subtitles` (or `@`)
* **Value / IP:** `13.201.42.114`

### 2. Configure Nginx Reverse Proxy
Install Nginx on your Ubuntu server:
```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/subtitles.conf`:
```nginx
server {
    server_name yourdomain.com www.yourdomain.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

Enable configuration and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/subtitles.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3. Generate Free SSL Certificate
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```
Certbot will configure SSL automatically. In AWS EC2, ensure Security Group inbound rules allow **Port 80 (HTTP)** and **Port 443 (HTTPS)**.

---

## 📄 License
This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

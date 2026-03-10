# .htaccess Redirect QA Validator

A React + Vite app that validates `.htaccess` redirect rules against a sitemap and explains them using **Google Gemini AI**.

Live app: **https://agskanchana.github.io/htaccess-checker/**

---

## Features

- Upload or paste `.htaccess` content (supports `Redirect`, `RedirectMatch`, `RewriteRule`)
- Fetch and parse XML sitemaps (including sitemap index files)
- Phase 1: Hard rule checks — detects broken destinations and incorrect 410s immediately
- Phase 2: Gemini AI analysis — semantic suggestions for redirect quality
- Filter and search results, export as CSV

---

## Architecture

```
Browser (GitHub Pages)
  │
  │  POST { prompt }
  ▼
Cloudflare Worker  ◄── GEMINI_API_KEY (secret, never in browser)
  │
  │  POST to Gemini API
  ▼
Google Gemini 1.5 Flash
```

The Cloudflare Worker acts as a **serverless proxy**: the browser never sees the Gemini API key.

---

## Gemini Proxy Setup

### 1. Get a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Click **Create API key**
3. Copy the key — you'll store it as a Worker secret (never in code)

### 2. Deploy the Cloudflare Worker

Prerequisites: [Node.js](https://nodejs.org) and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd worker
npx wrangler login          # authenticate with Cloudflare (one-time)
npx wrangler deploy         # deploy the Worker
```

Note the Worker URL printed after deployment (e.g. `https://htaccess-checker-proxy.<your-subdomain>.workers.dev`).

### 3. Set the Gemini API Key as a Worker Secret

```bash
cd worker
npx wrangler secret put GEMINI_API_KEY
# paste your Gemini API key when prompted — it is stored encrypted in Cloudflare
```

### 4. Configure the Proxy URL

**Option A — hardcode at build time (recommended for your own deployment)**

Add a repository secret in GitHub:
- Go to **Settings → Secrets and variables → Actions → New repository secret**
- Name: `VITE_GEMINI_PROXY_URL`
- Value: your Worker URL (e.g. `https://htaccess-checker-proxy.example.workers.dev`)

The GitHub Actions workflow already passes this secret to `npm run build`.  
The proxy URL will be pre-filled in the app for all visitors.

**Option B — enter it manually in the UI**

Leave the secret unset. The proxy URL input field in the app will be empty; users paste their own Worker URL before running validation.

---

## Local Development

```bash
npm install
npm run dev
```

The app runs at `http://localhost:5173/htaccess-checker/`. The **Gemini Proxy URL** field must be filled with a deployed Worker URL (or you can test with a local `wrangler dev` instance).

### Run the Worker locally

```bash
cd worker
npx wrangler dev --port 8787
```

Then set the proxy URL in the app to `http://localhost:8787`.

---

## Deployment to GitHub Pages

Deployments are automatic: every push to `main` triggers the workflow at `.github/workflows/deploy.yml`, which builds the app with Vite and pushes the `dist/` output to the `gh-pages` branch.

**One-time manual step** (only needed once):  
Go to **Settings → Pages → Build and deployment → Source**, select **Deploy from a branch**, then choose **`gh-pages`** / **`/ (root)`**.

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `VITE_GEMINI_PROXY_URL` | GitHub Actions secret | Pre-fills the proxy URL in the built app |
| `GEMINI_API_KEY` | Cloudflare Worker secret | Gemini API key — **never commit this** |

---

## Project Structure

```
htaccess-checker/
├── src/
│   ├── App.jsx          # Main React app
│   └── main.jsx
├── worker/
│   ├── index.js         # Cloudflare Worker (Gemini proxy)
│   └── wrangler.toml    # Worker configuration
├── .github/
│   └── workflows/
│       └── deploy.yml   # GitHub Pages CI/CD
├── vite.config.js
└── package.json
```


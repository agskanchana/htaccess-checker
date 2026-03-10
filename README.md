# .htaccess Redirect QA Validator

A vanilla JavaScript app that validates `.htaccess` redirect rules against a sitemap and explains them using **Google Gemini AI**. Runs directly on GitHub Pages — no build step required.

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

Because this app runs entirely in the browser on GitHub Pages, it **cannot** embed your Gemini API key safely. The solution is a tiny **Cloudflare Worker** that sits between the browser and Gemini: the browser sends a prompt to the Worker, the Worker adds the secret key and calls Gemini, then returns the result. The key is never sent to — or stored in — the browser.

```
GitHub Pages (browser)
   │  POST { prompt: "…" }
   ▼
Cloudflare Worker  ◄── GEMINI_API_KEY stored as encrypted Worker secret
   │  POST https://generativelanguage.googleapis.com/…?key=<secret>
   ▼
Google Gemini 1.5 Flash API
   │  { candidates: […] }
   ▼
Worker extracts text → returns { text: "…" } to browser
```

---

### Step 1 — Get a Gemini API Key

1. Open [Google AI Studio → API Keys](https://aistudio.google.com/app/apikey)
2. Click **Create API key** (choose any project, or create a new one)
3. Copy the key (starts with `AIza…`) — you will need it in Step 3

> **Keep this key private.** Never paste it into source code or share it publicly.

---

### Step 2 — Create a Free Cloudflare Account

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and create a **free** account
2. Verify your e-mail — no credit card is required for Workers

---

### Step 3 — Deploy the Cloudflare Worker

You need [Node.js 18+](https://nodejs.org) installed locally.

#### 3a. Authenticate with Cloudflare

```bash
cd worker
npx wrangler login
```

A browser window opens; log in with your Cloudflare account and click **Allow**.

#### 3b. Deploy the Worker

```bash
npx wrangler deploy
```

Wrangler compiles `worker/index.js` and uploads it.  
At the end you will see a line like:

```
Published htaccess-checker-proxy (0.00 sec)
  https://htaccess-checker-proxy.<your-subdomain>.workers.dev
```

**Copy this URL** — you'll paste it into the app.

#### 3c. Store the Gemini API Key as an encrypted secret

```bash
npx wrangler secret put GEMINI_API_KEY
```

When prompted, paste the `AIza…` key you copied in Step 1 and press **Enter**.  
The key is stored encrypted inside Cloudflare and is never visible after this point.

---

### Step 4 — Verify the Worker is Running

Open the Worker URL in a browser (GET request). You should see:

```json
{ "ok": true, "model": "gemini-1.5-flash" }
```

If you see `{"error":"GEMINI_API_KEY secret is not configured"}` go back to Step 3c.

---

### Step 5 — Configure the App

1. Open the live app: **https://agskanchana.github.io/htaccess-checker/**
2. Paste your Worker URL (e.g. `https://htaccess-checker-proxy.abc123.workers.dev`) into the **Gemini Proxy URL** field
3. Fill in the `.htaccess` content and sitemap URL, then click **Run Validation**

The app saves nothing server-side — every field is local to your browser session.

---

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Proxy error (500): {"error":"GEMINI_API_KEY secret is not configured"}` | Secret not set | Run `npx wrangler secret put GEMINI_API_KEY` again |
| `Proxy error (400)` | Bad request body | Check the Worker URL is correct (no trailing `/`) |
| `Failed to fetch` in browser | CORS or Worker not deployed | Redeploy with `npx wrangler deploy` |
| `SyntaxError` parsing Gemini response | Gemini returned markdown fences | Already handled — report the raw response in an issue |
| Worker URL works in browser but app says "Proxy error" | Trailing slash in URL | Remove the trailing slash from the Proxy URL field |

---

### Local Development with the Worker

You can run the Worker locally for faster iteration:

```bash
cd worker
npx wrangler dev --port 8787
```

Then set the proxy URL in the app to `http://localhost:8787`.

To set the API key for local development, create `worker/.dev.vars`:

```ini
GEMINI_API_KEY=AIza...your-key-here
```

> **Never commit `.dev.vars`** — it is already in `.gitignore`.

---

## Local Development

Open `index.html` directly in your browser, or use any static file server:

```bash
npx serve .
```

The **Gemini Proxy URL** field must be filled with a deployed Worker URL (or you can test with a local `wrangler dev` instance — see the Troubleshooting section above for `.dev.vars` setup).

---

## Deployment to GitHub Pages

Deployments are automatic: every push to `main` triggers the workflow at `.github/workflows/deploy.yml`, which pushes the static files to the `gh-pages` branch. No build step is needed.

**One-time manual step** (only needed once):
Go to **Settings → Pages → Build and deployment → Source**, select **Deploy from a branch**, then choose **`gh-pages`** / **`/ (root)`**.

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `GEMINI_API_KEY` | Cloudflare Worker secret | Gemini API key — **never commit this** |

---

## Project Structure

```
htaccess-checker/
├── index.html             # Main HTML page
├── js/
│   └── app.js             # Application logic (vanilla JS)
├── favicon.svg            # App icon
├── worker/
│   ├── index.js           # Cloudflare Worker (Gemini proxy)
│   └── wrangler.toml      # Worker configuration
├── .github/
│   └── workflows/
│       └── deploy.yml     # GitHub Pages CI/CD
└── .nojekyll              # Prevents Jekyll processing
```


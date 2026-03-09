import { useState, useCallback, useRef } from "react";

// ─── CORS Proxy ──────────────────────────────────────────────────────────────
const proxy = (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`;

// ─── .htaccess Parser ────────────────────────────────────────────────────────
function parseHtaccess(text) {
  const rules = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Redirect 301 /old /new
    // Redirect 410 /old
    // Redirect gone /old
    const redirectMatch = line.match(
      /^Redirect\s+(301|302|gone|410)\s+(\S+)(?:\s+(\S+))?/i
    );
    if (redirectMatch) {
      const code = redirectMatch[1].toLowerCase();
      const type = code === "gone" || code === "410" ? "410" : "301";
      const from = redirectMatch[2];
      const to = redirectMatch[3] || null;
      rules.push({ type, from, to, isRegex: false });
      continue;
    }

    // RedirectMatch 301 ^/old-pattern$ /new-path
    const redirectMatchRule = line.match(
      /^RedirectMatch\s+(301|302|gone|410)\s+(\S+)(?:\s+(\S+))?/i
    );
    if (redirectMatchRule) {
      const code = redirectMatchRule[1].toLowerCase();
      const type = code === "gone" || code === "410" ? "410" : "301";
      const from = redirectMatchRule[2];
      const to = redirectMatchRule[3] || null;
      rules.push({ type, from, to, isRegex: true });
      continue;
    }

    // RewriteRule ^old-path$ /new-path [R=301,L]
    // RewriteRule ^old-path$ - [R=410,L]
    const rewriteMatch = line.match(
      /^RewriteRule\s+(\S+)\s+(\S+)\s+\[([^\]]*)\]/i
    );
    if (rewriteMatch) {
      const pattern = rewriteMatch[1];
      const dest = rewriteMatch[2];
      const flags = rewriteMatch[3];
      const rFlag = flags.match(/R=(\d+)/i);
      if (rFlag) {
        const code = rFlag[1];
        const type = code === "410" ? "410" : "301";
        const to = dest === "-" ? null : dest;
        rules.push({ type, from: pattern, to, isRegex: true });
      }
      continue;
    }
  }
  return rules;
}

// ─── XML Sitemap Parser ───────────────────────────────────────────────────────
function parseSitemap(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const sitemapLocs = Array.from(doc.querySelectorAll("sitemap > loc")).map(
    (el) => el.textContent.trim()
  );
  const urlLocs = Array.from(doc.querySelectorAll("url > loc")).map((el) =>
    el.textContent.trim()
  );
  return { sitemapLocs, urlLocs };
}

function toPathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ─── Phase 1 — Hard Rule Checks ──────────────────────────────────────────────
function runPhase1(rules, sitemapPaths) {
  const pathSet = new Set(sitemapPaths);
  return rules.map((rule) => {
    if (rule.isRegex) {
      return {
        ...rule,
        status: "skip",
        message: "Regex rule — manual review needed",
        suggestion: null,
      };
    }
    if (rule.type === "301") {
      const destPath = rule.to ? toPathname(rule.to) : null;
      if (!destPath || !pathSet.has(destPath)) {
        return {
          ...rule,
          status: "error",
          message: "Broken redirect — destination not found in sitemap",
          suggestion: null,
        };
      }
      return { ...rule, status: "pending", message: "", suggestion: null };
    }
    if (rule.type === "410") {
      const fromPath = toPathname(rule.from);
      if (pathSet.has(fromPath)) {
        return {
          ...rule,
          status: "error",
          message: "Page still exists in sitemap — should not be 410",
          suggestion: null,
        };
      }
      return { ...rule, status: "pending", message: "", suggestion: null };
    }
    return { ...rule, status: "skip", message: "Unknown rule type", suggestion: null };
  });
}

// ─── Phase 2 — AI Analysis ────────────────────────────────────────────────────
async function runPhase2(pendingRules, sitemapPaths, token) {
  const rulesJson = JSON.stringify(
    pendingRules.map(({ type, from, to }) => ({ type, from, to })),
    null,
    2
  );
  const sitemapPathsStr = sitemapPaths.join("\n");

  const prompt = `You are a redirect QA validator for website redesigns.

You will be given a list of redirect rules and all valid URLs on the new site.

For each rule, return a JSON array where each item has:
- "from": the original path
- "type": "301" or "410"
- "to": destination path (null for 410)
- "status": "ok" or "warn"
- "message": short explanation
- "suggestion": best alternative path from the sitemap, or null

Analysis rules:

For 301 redirects (destination already confirmed in sitemap):
- If destination is the best semantic match for the old URL → "ok"
- If a semantically closer page exists in the sitemap → "warn", set suggestion to that page

For 410 Gone (page confirmed absent from sitemap):
- If no relevant replacement exists in the sitemap → "ok", 410 is correct
- If a semantically similar page exists → "warn", message: "Consider a 301 to this page instead", set suggestion

Use semantic understanding, not just string similarity:
- /our-doctors and /meet-the-team are related
- /dental-implants and /services/implants are related
- /temp-promo has no semantic match — keep as 410

Respond ONLY with a valid JSON array. No markdown, no explanation.

REDIRECT RULES:
${rulesJson}

NEW SITE URLs:
${sitemapPathsStr}`;

  const response = await fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Copilot API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  const raw = data.choices[0].message.content;
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCsv(results) {
  const headers = ["Type", "From", "To", "Status", "Message", "Suggestion"];
  const rows = results.map((r) => [
    r.type,
    r.from,
    r.to || "",
    r.status.toUpperCase(),
    r.message,
    r.suggestion || "",
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "redirect-qa-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── UI Components ────────────────────────────────────────────────────────────
function Badge({ label, color }) {
  const colors = {
    blue: "bg-blue-100 text-blue-800",
    orange: "bg-orange-100 text-orange-800",
    green: "bg-green-100 text-green-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${colors[color] || colors.gray}`}
    >
      {label}
    </span>
  );
}

function TypeBadge({ type }) {
  return <Badge label={type} color={type === "301" ? "blue" : "orange"} />;
}

function StatusBadge({ status }) {
  const map = {
    ok: { label: "OK", color: "green" },
    warn: { label: "WARN", color: "amber" },
    error: { label: "ERROR", color: "red" },
    skip: { label: "SKIP", color: "gray" },
  };
  const s = map[status] || { label: status.toUpperCase(), color: "gray" };
  return <Badge label={s.label} color={s.color} />;
}

function Banner({ type, children }) {
  const styles = {
    red: "bg-red-50 border border-red-300 text-red-800",
    amber: "bg-amber-50 border border-amber-300 text-amber-800",
  };
  return (
    <div className={`rounded-lg p-3 text-sm ${styles[type]}`}>{children}</div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [htaccessText, setHtaccessText] = useState("");
  const [htaccessFileName, setHtaccessFileName] = useState("");
  const [sitemapUrl, setSitemapUrl] = useState("");

  const [sitemapFetching, setSitemapFetching] = useState(false);
  const [sitemapProgress, setSitemapProgress] = useState(null);
  const [sitemapSummary, setSitemapSummary] = useState(null);
  const [sitemapPaths, setSitemapPaths] = useState([]);
  const [sitemapError, setSitemapError] = useState("");

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [errors, setErrors] = useState([]);

  const [activeFilter, setActiveFilter] = useState("all");
  const [search, setSearch] = useState("");

  const dropRef = useRef(null);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setHtaccessText(ev.target.result);
      setHtaccessFileName(file.name);
    };
    reader.readAsText(file);
  }, []);

  const handleDragOver = (e) => e.preventDefault();

  const handleFileInput = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setHtaccessText(ev.target.result);
      setHtaccessFileName(file.name);
    };
    reader.readAsText(file);
  };

  const fetchSitemaps = useCallback(async () => {
    if (!sitemapUrl.trim()) return;
    setSitemapFetching(true);
    setSitemapError("");
    setSitemapSummary(null);
    setSitemapPaths([]);
    setSitemapProgress(null);

    try {
      const indexRes = await fetch(proxy(sitemapUrl.trim()));
      if (!indexRes.ok) throw new Error(`Failed to fetch sitemap index (${indexRes.status})`);
      const indexXml = await indexRes.text();
      const { sitemapLocs, urlLocs } = parseSitemap(indexXml);

      let allPaths = [];
      let summary = [];

      if (sitemapLocs.length > 0) {
        setSitemapProgress({ loaded: 0, total: sitemapLocs.length });
        let loaded = 0;

        const childResults = await Promise.all(
          sitemapLocs.map(async (childUrl) => {
            const name = childUrl.split("/").pop() || childUrl;
            try {
              const res = await fetch(proxy(childUrl));
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const xml = await res.text();
              const { urlLocs: childUrls } = parseSitemap(xml);
              loaded++;
              setSitemapProgress({ loaded, total: sitemapLocs.length });
              return { name, count: childUrls.length, urls: childUrls, error: null };
            } catch (err) {
              loaded++;
              setSitemapProgress({ loaded, total: sitemapLocs.length });
              return { name, count: 0, urls: [], error: err.message };
            }
          })
        );

        for (const child of childResults) {
          summary.push({ name: child.name, count: child.count, error: child.error });
          allPaths.push(...child.urls.map(toPathname));
        }
      } else if (urlLocs.length > 0) {
        const name = sitemapUrl.trim().split("/").pop() || "sitemap.xml";
        summary.push({ name, count: urlLocs.length, error: null });
        allPaths = urlLocs.map(toPathname);
      } else {
        throw new Error("No URLs found in sitemap");
      }

      allPaths = [...new Set(allPaths)];
      setSitemapSummary(summary);
      setSitemapPaths(allPaths);
    } catch (err) {
      setSitemapError(err.message);
    } finally {
      setSitemapFetching(false);
      setSitemapProgress(null);
    }
  }, [sitemapUrl]);

  const runValidation = useCallback(async () => {
    setRunning(true);
    setResults(null);
    setErrors([]);
    setActiveFilter("all");
    setSearch("");

    try {
      const rules = parseHtaccess(htaccessText);
      if (rules.length === 0) {
        setErrors(["No redirect rules found in .htaccess content."]);
        setRunning(false);
        return;
      }

      const phase1Results = runPhase1(rules, sitemapPaths);
      const pendingRules = phase1Results.filter((r) => r.status === "pending");

      if (pendingRules.length === 0) {
        setResults(
          phase1Results.map((r) =>
            r.status === "pending"
              ? { ...r, status: "ok", message: "Passes all checks" }
              : r
          )
        );
        setRunning(false);
        return;
      }

      let aiResults;
      try {
        aiResults = await runPhase2(pendingRules, sitemapPaths, token);
      } catch (err) {
        setErrors([`Copilot API error — check your token and Copilot access. (${err.message})`]);
        setResults(
          phase1Results.map((r) =>
            r.status === "pending"
              ? { ...r, status: "skip", message: "AI analysis unavailable" }
              : r
          )
        );
        setRunning(false);
        return;
      }

      const aiMap = new Map(aiResults.map((r) => [r.from, r]));
      const finalResults = phase1Results.map((r) => {
        if (r.status !== "pending") return r;
        const ai = aiMap.get(r.from);
        if (!ai) return { ...r, status: "ok", message: "AI did not return data for this rule", suggestion: null };
        return {
          ...r,
          status: ai.status,
          message: ai.message,
          suggestion: ai.suggestion || null,
        };
      });

      setResults(finalResults);
    } catch (err) {
      setErrors([`Unexpected error: ${err.message}`]);
    } finally {
      setRunning(false);
    }
  }, [htaccessText, sitemapPaths, token]);

  const canRun =
    token.trim() &&
    htaccessText.trim() &&
    sitemapPaths.length > 0 &&
    !running;

  const filteredResults = results
    ? results.filter((r) => {
        const matchesFilter =
          activeFilter === "all" || r.status === activeFilter;
        const q = search.toLowerCase();
        const matchesSearch =
          !q ||
          r.from.toLowerCase().includes(q) ||
          (r.to || "").toLowerCase().includes(q) ||
          r.message.toLowerCase().includes(q) ||
          (r.suggestion || "").toLowerCase().includes(q);
        return matchesFilter && matchesSearch;
      })
    : [];

  const counts = results
    ? {
        ok: results.filter((r) => r.status === "ok").length,
        warn: results.filter((r) => r.status === "warn").length,
        error: results.filter((r) => r.status === "error").length,
        skip: results.filter((r) => r.status === "skip").length,
        total: results.length,
      }
    : null;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">
          🔀 Redirect QA Validator
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Validate .htaccess redirects against your sitemap with AI assistance
        </p>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Inputs Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* 1. GitHub Token */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
            <label className="block text-sm font-semibold text-gray-700">
              GitHub Personal Access Token
            </label>
            <div className="relative">
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm pr-12 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs px-1 py-0.5 bg-transparent border-0"
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-gray-400">
              Needs Copilot access.{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                Generate at github.com/settings/tokens
              </a>
            </p>
          </div>

          {/* 2. .htaccess File */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
            <label className="block text-sm font-semibold text-gray-700">
              .htaccess File
            </label>
            <div
              ref={dropRef}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className="border-2 border-dashed border-gray-300 rounded-lg p-3 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
              onClick={() => document.getElementById("htaccess-file-input").click()}
            >
              {htaccessFileName ? (
                <p className="text-sm text-green-700 font-medium">✓ {htaccessFileName}</p>
              ) : (
                <>
                  <p className="text-sm text-gray-500">Drag & drop .htaccess here</p>
                  <p className="text-xs text-gray-400 mt-0.5">or click to browse</p>
                </>
              )}
            </div>
            <input
              id="htaccess-file-input"
              type="file"
              accept=".htaccess,text/*"
              className="hidden"
              onChange={handleFileInput}
            />
            <p className="text-xs text-gray-400">Or paste content below:</p>
            <textarea
              value={htaccessText}
              onChange={(e) => {
                setHtaccessText(e.target.value);
                if (!htaccessFileName) setHtaccessFileName("(pasted)");
              }}
              placeholder={"Redirect 301 /old-path /new-path\nRedirect 410 /deleted-page"}
              rows={4}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* 3. Sitemap URL */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
            <label className="block text-sm font-semibold text-gray-700">
              Sitemap Index URL
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={sitemapUrl}
                onChange={(e) => setSitemapUrl(e.target.value)}
                placeholder="https://example.com/sitemap_index.xml"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={(e) => e.key === "Enter" && fetchSitemaps()}
              />
              <button
                onClick={fetchSitemaps}
                disabled={!sitemapUrl.trim() || sitemapFetching}
                className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {sitemapFetching ? "…" : "Fetch"}
              </button>
            </div>

            {sitemapProgress && (
              <p className="text-xs text-blue-600 animate-pulse">
                Fetching sitemaps… {sitemapProgress.loaded}/{sitemapProgress.total} loaded
              </p>
            )}

            {sitemapError && <Banner type="red">{sitemapError}</Banner>}

            {sitemapSummary && (
              <div className="text-xs space-y-1 border-t border-gray-100 pt-2">
                {sitemapSummary.map((s) => (
                  <div key={s.name}>
                    {s.error ? (
                      <span className="text-amber-600">⚠ {s.name} — {s.error}</span>
                    ) : (
                      <span className="text-green-700">
                        ✓ {s.name}{" "}
                        <span className="text-gray-400">({s.count} URLs)</span>
                      </span>
                    )}
                  </div>
                ))}
                <div className="border-t border-gray-200 pt-1 text-gray-600 font-semibold">
                  Total: {sitemapPaths.length} URLs collected
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Global error banners */}
        {errors.map((err, i) => (
          <Banner key={i} type="red">{err}</Banner>
        ))}

        {/* Run Button */}
        <div className="flex justify-center">
          <button
            onClick={runValidation}
            disabled={!canRun}
            className="px-8 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm text-sm"
          >
            {running ? "Analysing with AI…" : "Run Validation"}
          </button>
        </div>

        {/* Results */}
        {results && (
          <div className="space-y-4">
            {/* Summary Bar */}
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex flex-wrap gap-4 items-center">
                <span className="text-sm font-semibold text-gray-600">Results:</span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block"></span>
                  <span className="text-sm text-gray-700">OK: <strong>{counts.ok}</strong></span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"></span>
                  <span className="text-sm text-gray-700">WARN: <strong>{counts.warn}</strong></span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"></span>
                  <span className="text-sm text-gray-700">ERROR: <strong>{counts.error}</strong></span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-gray-400 inline-block"></span>
                  <span className="text-sm text-gray-700">SKIP: <strong>{counts.skip}</strong></span>
                </span>
                <span className="text-sm text-gray-500 ml-auto">
                  Total: <strong>{counts.total}</strong>
                </span>
              </div>
            </div>

            {/* Filters & Controls */}
            <div className="flex flex-wrap gap-2 items-center">
              {["all", "ok", "warn", "error", "skip"].map((f) => (
                <button
                  key={f}
                  onClick={() => setActiveFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    activeFilter === f
                      ? "bg-indigo-600 text-white"
                      : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search URL or message…"
                className="flex-1 min-w-[180px] border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => exportCsv(results)}
                className="px-3 py-1.5 bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 rounded-lg text-xs font-semibold transition-colors"
              >
                Export CSV
              </button>
            </div>

            {/* Results Table */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-16">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">From</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">To</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-20">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Message + AI Suggestion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredResults.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">
                          No results match the current filter.
                        </td>
                      </tr>
                    ) : (
                      filteredResults.map((r, i) => (
                        <tr
                          key={i}
                          className={
                            r.status === "error"
                              ? "bg-red-50"
                              : r.status === "warn"
                              ? "bg-amber-50"
                              : ""
                          }
                        >
                          <td className="px-4 py-3"><TypeBadge type={r.type} /></td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-700 break-all">{r.from}</td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-700 break-all">
                            {r.to || <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                          <td className="px-4 py-3 text-xs text-gray-600">
                            <span>{r.message}</span>
                            {r.suggestion && (
                              <div className="mt-1 text-indigo-600 font-medium">
                                → Better match: <span className="font-mono">{r.suggestion}</span>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── CORS Proxy ──────────────────────────────────────────────────────────────
function proxy(url) {
  return "https://corsproxy.io/?url=" + encodeURIComponent(url);
}

// ─── .htaccess Parser ────────────────────────────────────────────────────────
function parseHtaccess(text) {
  var rules = [];
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;

    // Redirect 301 /old /new  |  Redirect 410 /old  |  Redirect gone /old
    var redirectMatch = line.match(
      /^Redirect\s+(301|302|gone|410)\s+(\S+)(?:\s+(\S+))?/i
    );
    if (redirectMatch) {
      var code = redirectMatch[1].toLowerCase();
      var type = code === "gone" || code === "410" ? "410" : "301";
      rules.push({ type: type, from: redirectMatch[2], to: redirectMatch[3] || null, isRegex: false });
      continue;
    }

    // RedirectMatch 301 ^/old-pattern$ /new-path
    var redirectMatchRule = line.match(
      /^RedirectMatch\s+(301|302|gone|410)\s+(\S+)(?:\s+(\S+))?/i
    );
    if (redirectMatchRule) {
      var code2 = redirectMatchRule[1].toLowerCase();
      var type2 = code2 === "gone" || code2 === "410" ? "410" : "301";
      rules.push({ type: type2, from: redirectMatchRule[2], to: redirectMatchRule[3] || null, isRegex: true });
      continue;
    }

    // RewriteRule ^old-path$ /new-path [R=301,L]
    var rewriteMatch = line.match(
      /^RewriteRule\s+(\S+)\s+(\S+)\s+\[([^\]]*)\]/i
    );
    if (rewriteMatch) {
      var pattern = rewriteMatch[1];
      var dest = rewriteMatch[2];
      var flags = rewriteMatch[3];
      var rFlag = flags.match(/R=(\d+)/i);
      if (rFlag) {
        var rCode = rFlag[1];
        var rType = rCode === "410" ? "410" : "301";
        var rTo = dest === "-" ? null : dest;
        rules.push({ type: rType, from: pattern, to: rTo, isRegex: true });
      }
      continue;
    }
  }
  return rules;
}

// ─── XML Sitemap Parser ───────────────────────────────────────────────────────
function parseSitemap(xmlText) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(xmlText, "text/xml");
  var sitemapLocs = Array.from(doc.querySelectorAll("sitemap > loc")).map(
    function (el) { return el.textContent.trim(); }
  );
  var urlLocs = Array.from(doc.querySelectorAll("url > loc")).map(
    function (el) { return el.textContent.trim(); }
  );
  return { sitemapLocs: sitemapLocs, urlLocs: urlLocs };
}

function toPathname(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return url;
  }
}

// ─── Phase 1 — Hard Rule Checks ──────────────────────────────────────────────
function runPhase1(rules, sitemapPaths) {
  var pathSet = new Set(sitemapPaths);
  return rules.map(function (rule) {
    if (rule.isRegex) {
      return {
        type: rule.type, from: rule.from, to: rule.to, isRegex: rule.isRegex,
        status: "skip", message: "Regex rule — manual review needed", suggestion: null
      };
    }
    if (rule.type === "301") {
      var destPath = rule.to ? toPathname(rule.to) : null;
      if (!destPath || !pathSet.has(destPath)) {
        return {
          type: rule.type, from: rule.from, to: rule.to, isRegex: rule.isRegex,
          status: "error", message: "Broken redirect — destination not found in sitemap", suggestion: null
        };
      }
      return { type: rule.type, from: rule.from, to: rule.to, isRegex: rule.isRegex, status: "pending", message: "", suggestion: null };
    }
    if (rule.type === "410") {
      var fromPath = toPathname(rule.from);
      if (pathSet.has(fromPath)) {
        return {
          type: rule.type, from: rule.from, to: rule.to, isRegex: rule.isRegex,
          status: "error", message: "Page still exists in sitemap — should not be 410", suggestion: null
        };
      }
      return { type: rule.type, from: rule.from, to: rule.to, isRegex: rule.isRegex, status: "pending", message: "", suggestion: null };
    }
    return { type: rule.type, from: rule.from, to: rule.to, isRegex: rule.isRegex, status: "skip", message: "Unknown rule type", suggestion: null };
  });
}

// ─── Phase 2 — Gemini AI Analysis ────────────────────────────────────────────
async function runPhase2(pendingRules, sitemapPaths, proxyUrl) {
  var rulesJson = JSON.stringify(
    pendingRules.map(function (r) { return { type: r.type, from: r.from, to: r.to }; }),
    null, 2
  );
  var sitemapPathsStr = sitemapPaths.join("\n");

  var prompt = "You are a redirect QA validator for website redesigns.\n\n" +
    "You will be given a list of redirect rules and all valid URLs on the new site.\n\n" +
    "For each rule, return a JSON array where each item has:\n" +
    '- "from": the original path\n' +
    '- "type": "301" or "410"\n' +
    '- "to": destination path (null for 410)\n' +
    '- "status": "ok" or "warn"\n' +
    '- "message": short explanation\n' +
    '- "suggestion": best alternative path from the sitemap, or null\n\n' +
    "Analysis rules:\n\n" +
    "For 301 redirects (destination already confirmed in sitemap):\n" +
    '- If destination is the best semantic match for the old URL → "ok"\n' +
    '- If a semantically closer page exists in the sitemap → "warn", set suggestion to that page\n\n' +
    "For 410 Gone (page confirmed absent from sitemap):\n" +
    '- If no relevant replacement exists in the sitemap → "ok", 410 is correct\n' +
    '- If a semantically similar page exists → "warn", message: "Consider a 301 to this page instead", set suggestion\n\n' +
    "Use semantic understanding, not just string similarity:\n" +
    "- /our-doctors and /meet-the-team are related\n" +
    "- /dental-implants and /services/implants are related\n" +
    "- /temp-promo has no semantic match — keep as 410\n\n" +
    "Respond ONLY with a valid JSON array. No markdown, no explanation.\n\n" +
    "REDIRECT RULES:\n" + rulesJson + "\n\n" +
    "NEW SITE URLs:\n" + sitemapPathsStr;

  var response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: prompt })
  });

  if (!response.ok) {
    var body = await response.text();
    throw new Error("Proxy error (" + response.status + "): " + body);
  }

  var data = await response.json();
  if (data.error) throw new Error("Gemini proxy returned error: " + data.error);
  var raw = typeof data.text === "string" ? data.text : "";
  var clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCsv(results) {
  var headers = ["Type", "From", "To", "Status", "Message", "Suggestion"];
  var rows = results.map(function (r) {
    return [r.type, r.from, r.to || "", r.status.toUpperCase(), r.message, r.suggestion || ""];
  });
  var all = [headers].concat(rows);
  var csv = all.map(function (row) {
    return row.map(function (cell) {
      return '"' + String(cell).replace(/"/g, '""') + '"';
    }).join(",");
  }).join("\n");
  var blob = new Blob([csv], { type: "text/csv" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "redirect-qa-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Escape HTML ──────────────────────────────────────────────────────────────
function esc(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ─── App State ────────────────────────────────────────────────────────────────
var state = {
  proxyUrl: "",
  htaccessText: "",
  htaccessFileName: "",
  sitemapUrl: "",
  sitemapFetching: false,
  sitemapProgress: null,
  sitemapSummary: null,
  sitemapPaths: [],
  sitemapError: "",
  running: false,
  results: null,
  errors: [],
  activeFilter: "all",
  search: ""
};

// ─── DOM Ready ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function () {
  // Element references
  var proxyInput = document.getElementById("proxy-url");
  var dropZone = document.getElementById("drop-zone");
  var dropLabel = document.getElementById("drop-label");
  var fileInput = document.getElementById("htaccess-file-input");
  var htaccessTextarea = document.getElementById("htaccess-textarea");
  var sitemapInput = document.getElementById("sitemap-url");
  var fetchBtn = document.getElementById("fetch-btn");
  var sitemapStatus = document.getElementById("sitemap-status");
  var errorsDiv = document.getElementById("errors");
  var runBtn = document.getElementById("run-btn");
  var resultsSection = document.getElementById("results-section");
  var summaryBar = document.getElementById("summary-bar");
  var filterBar = document.getElementById("filter-bar");
  var searchInput = document.getElementById("search-input");
  var exportBtn = document.getElementById("export-btn");
  var tbody = document.getElementById("results-tbody");

  // ── Proxy URL ──
  proxyInput.addEventListener("input", function () {
    state.proxyUrl = proxyInput.value;
    updateRunBtn();
  });

  // ── File Drop ──
  dropZone.addEventListener("dragover", function (e) { e.preventDefault(); });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    var file = e.dataTransfer.files[0];
    if (!file) return;
    readFile(file);
  });
  dropZone.addEventListener("click", function () { fileInput.click(); });

  fileInput.addEventListener("change", function () {
    var file = fileInput.files[0];
    if (!file) return;
    readFile(file);
  });

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      state.htaccessText = ev.target.result;
      state.htaccessFileName = file.name;
      htaccessTextarea.value = ev.target.result;
      dropLabel.innerHTML = '<p class="text-sm text-green-700 font-medium">\u2713 ' + esc(file.name) + '</p>';
      updateRunBtn();
    };
    reader.readAsText(file);
  }

  htaccessTextarea.addEventListener("input", function () {
    state.htaccessText = htaccessTextarea.value;
    if (!state.htaccessFileName && htaccessTextarea.value) state.htaccessFileName = "(pasted)";
    updateRunBtn();
  });

  // ── Sitemap ──
  sitemapInput.addEventListener("input", function () {
    state.sitemapUrl = sitemapInput.value;
    fetchBtn.disabled = !sitemapInput.value.trim();
  });
  sitemapInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") fetchSitemaps();
  });
  fetchBtn.addEventListener("click", fetchSitemaps);

  async function fetchSitemaps() {
    if (!state.sitemapUrl.trim() || state.sitemapFetching) return;
    state.sitemapFetching = true;
    state.sitemapError = "";
    state.sitemapSummary = null;
    state.sitemapPaths = [];
    state.sitemapProgress = null;
    fetchBtn.disabled = true;
    fetchBtn.textContent = "\u2026";
    sitemapStatus.innerHTML = '<p class="text-xs text-blue-600 animate-pulse">Fetching sitemaps\u2026</p>';

    try {
      var indexRes = await fetch(proxy(state.sitemapUrl.trim()));
      if (!indexRes.ok) throw new Error("Failed to fetch sitemap index (" + indexRes.status + ")");
      var indexXml = await indexRes.text();
      var parsed = parseSitemap(indexXml);

      var allPaths = [];
      var summary = [];

      if (parsed.sitemapLocs.length > 0) {
        var total = parsed.sitemapLocs.length;
        var loaded = 0;
        sitemapStatus.innerHTML = '<p class="text-xs text-blue-600 animate-pulse">Fetching sitemaps\u2026 0/' + total + ' loaded</p>';

        var childResults = await Promise.all(
          parsed.sitemapLocs.map(async function (childUrl) {
            var name = childUrl.split("/").pop() || childUrl;
            try {
              var res = await fetch(proxy(childUrl));
              if (!res.ok) throw new Error("HTTP " + res.status);
              var xml = await res.text();
              var childParsed = parseSitemap(xml);
              loaded++;
              sitemapStatus.innerHTML = '<p class="text-xs text-blue-600 animate-pulse">Fetching sitemaps\u2026 ' + loaded + '/' + total + ' loaded</p>';
              return { name: name, count: childParsed.urlLocs.length, urls: childParsed.urlLocs, error: null };
            } catch (err) {
              loaded++;
              sitemapStatus.innerHTML = '<p class="text-xs text-blue-600 animate-pulse">Fetching sitemaps\u2026 ' + loaded + '/' + total + ' loaded</p>';
              return { name: name, count: 0, urls: [], error: err.message };
            }
          })
        );

        for (var i = 0; i < childResults.length; i++) {
          var child = childResults[i];
          summary.push({ name: child.name, count: child.count, error: child.error });
          for (var j = 0; j < child.urls.length; j++) {
            allPaths.push(toPathname(child.urls[j]));
          }
        }
      } else if (parsed.urlLocs.length > 0) {
        var name = state.sitemapUrl.trim().split("/").pop() || "sitemap.xml";
        summary.push({ name: name, count: parsed.urlLocs.length, error: null });
        allPaths = parsed.urlLocs.map(toPathname);
      } else {
        throw new Error("No URLs found in sitemap");
      }

      allPaths = Array.from(new Set(allPaths));
      state.sitemapSummary = summary;
      state.sitemapPaths = allPaths;

      // Render summary
      var html = '<div class="text-xs space-y-1 border-t border-gray-100 pt-2">';
      for (var k = 0; k < summary.length; k++) {
        var s = summary[k];
        if (s.error) {
          html += '<div><span class="text-amber-600">\u26A0 ' + esc(s.name) + ' \u2014 ' + esc(s.error) + '</span></div>';
        } else {
          html += '<div><span class="text-green-700">\u2713 ' + esc(s.name) + ' <span class="text-gray-400">(' + s.count + ' URLs)</span></span></div>';
        }
      }
      html += '<div class="border-t border-gray-200 pt-1 text-gray-600 font-semibold">Total: ' + allPaths.length + ' URLs collected</div>';
      html += '</div>';
      sitemapStatus.innerHTML = html;

    } catch (err) {
      state.sitemapError = err.message;
      sitemapStatus.innerHTML = '<div class="rounded-lg p-3 text-sm bg-red-50 border border-red-300 text-red-800">' + esc(err.message) + '</div>';
    } finally {
      state.sitemapFetching = false;
      fetchBtn.disabled = !state.sitemapUrl.trim();
      fetchBtn.textContent = "Fetch";
      updateRunBtn();
    }
  }

  // ── Run Validation ──
  runBtn.addEventListener("click", runValidation);

  async function runValidation() {
    state.running = true;
    state.results = null;
    state.errors = [];
    state.activeFilter = "all";
    state.search = "";
    searchInput.value = "";
    updateRunBtn();
    errorsDiv.innerHTML = "";
    resultsSection.classList.add("hidden");

    try {
      var rules = parseHtaccess(state.htaccessText);
      if (rules.length === 0) {
        showErrors(["No redirect rules found in .htaccess content."]);
        state.running = false;
        updateRunBtn();
        return;
      }

      var phase1Results = runPhase1(rules, state.sitemapPaths);
      var pendingRules = phase1Results.filter(function (r) { return r.status === "pending"; });

      if (pendingRules.length === 0) {
        state.results = phase1Results.map(function (r) {
          return r.status === "pending"
            ? { type: r.type, from: r.from, to: r.to, isRegex: r.isRegex, status: "ok", message: "Passes all checks", suggestion: null }
            : r;
        });
        renderResults();
        state.running = false;
        updateRunBtn();
        return;
      }

      var aiResults;
      try {
        aiResults = await runPhase2(pendingRules, state.sitemapPaths, state.proxyUrl);
      } catch (err) {
        showErrors(["Gemini proxy error \u2014 check your proxy URL and Gemini API key. (" + err.message + ")"]);
        state.results = phase1Results.map(function (r) {
          return r.status === "pending"
            ? { type: r.type, from: r.from, to: r.to, isRegex: r.isRegex, status: "skip", message: "AI analysis unavailable", suggestion: null }
            : r;
        });
        renderResults();
        state.running = false;
        updateRunBtn();
        return;
      }

      var aiMap = new Map(aiResults.map(function (r) { return [r.from, r]; }));
      state.results = phase1Results.map(function (r) {
        if (r.status !== "pending") return r;
        var ai = aiMap.get(r.from);
        if (!ai) return { type: r.type, from: r.from, to: r.to, isRegex: r.isRegex, status: "ok", message: "AI did not return data for this rule", suggestion: null };
        return {
          type: r.type, from: r.from, to: r.to, isRegex: r.isRegex,
          status: ai.status, message: ai.message, suggestion: ai.suggestion || null
        };
      });

      renderResults();
    } catch (err) {
      showErrors(["Unexpected error: " + err.message]);
    } finally {
      state.running = false;
      updateRunBtn();
    }
  }

  // ── Helpers ──
  function updateRunBtn() {
    var canRun = state.proxyUrl.trim() && state.htaccessText.trim() && state.sitemapPaths.length > 0 && !state.running;
    runBtn.disabled = !canRun;
    runBtn.textContent = state.running ? "Analysing with AI\u2026" : "Run Validation";
  }

  function showErrors(errArr) {
    state.errors = errArr;
    errorsDiv.innerHTML = errArr.map(function (e) {
      return '<div class="rounded-lg p-3 text-sm bg-red-50 border border-red-300 text-red-800">' + esc(e) + '</div>';
    }).join("");
  }

  function getFilteredResults() {
    if (!state.results) return [];
    var q = state.search.toLowerCase();
    return state.results.filter(function (r) {
      var matchesFilter = state.activeFilter === "all" || r.status === state.activeFilter;
      var matchesSearch = !q ||
        r.from.toLowerCase().indexOf(q) !== -1 ||
        (r.to || "").toLowerCase().indexOf(q) !== -1 ||
        r.message.toLowerCase().indexOf(q) !== -1 ||
        (r.suggestion || "").toLowerCase().indexOf(q) !== -1;
      return matchesFilter && matchesSearch;
    });
  }

  function getCounts() {
    if (!state.results) return null;
    return {
      ok: state.results.filter(function (r) { return r.status === "ok"; }).length,
      warn: state.results.filter(function (r) { return r.status === "warn"; }).length,
      error: state.results.filter(function (r) { return r.status === "error"; }).length,
      skip: state.results.filter(function (r) { return r.status === "skip"; }).length,
      total: state.results.length
    };
  }

  function renderResults() {
    if (!state.results) {
      resultsSection.classList.add("hidden");
      return;
    }
    resultsSection.classList.remove("hidden");
    var counts = getCounts();

    // Summary bar
    summaryBar.innerHTML =
      '<span class="text-sm font-semibold text-gray-600">Results:</span>' +
      '<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-green-500 inline-block"></span><span class="text-sm text-gray-700">OK: <strong>' + counts.ok + '</strong></span></span>' +
      '<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"></span><span class="text-sm text-gray-700">WARN: <strong>' + counts.warn + '</strong></span></span>' +
      '<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"></span><span class="text-sm text-gray-700">ERROR: <strong>' + counts.error + '</strong></span></span>' +
      '<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-gray-400 inline-block"></span><span class="text-sm text-gray-700">SKIP: <strong>' + counts.skip + '</strong></span></span>' +
      '<span class="text-sm text-gray-500 ml-auto">Total: <strong>' + counts.total + '</strong></span>';

    // Filters
    renderFilters();
    renderTable();
  }

  function renderFilters() {
    var filters = ["all", "ok", "warn", "error", "skip"];
    var html = "";
    for (var i = 0; i < filters.length; i++) {
      var f = filters[i];
      var active = state.activeFilter === f;
      html += '<button data-filter="' + f + '" class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ' +
        (active ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50') +
        '">' + f.toUpperCase() + '</button>';
    }
    filterBar.innerHTML = html;

    // Re-attach filter listeners
    var buttons = filterBar.querySelectorAll("[data-filter]");
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].addEventListener("click", function () {
        state.activeFilter = this.getAttribute("data-filter");
        renderFilters();
        renderTable();
      });
    }
  }

  searchInput.addEventListener("input", function () {
    state.search = searchInput.value;
    renderTable();
  });

  exportBtn.addEventListener("click", function () {
    if (state.results) exportCsv(state.results);
  });

  function renderTable() {
    var filtered = getFilteredResults();
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-gray-400 text-sm">No results match the current filter.</td></tr>';
      return;
    }
    var html = "";
    for (var i = 0; i < filtered.length; i++) {
      var r = filtered[i];
      var rowClass = r.status === "error" ? "bg-red-50" : r.status === "warn" ? "bg-amber-50" : "";

      // Type badge
      var typeColor = r.type === "301" ? "bg-blue-100 text-blue-800" : "bg-orange-100 text-orange-800";
      var typeBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ' + typeColor + '">' + esc(r.type) + '</span>';

      // Status badge
      var statusMap = {
        ok: { label: "OK", color: "bg-green-100 text-green-800" },
        warn: { label: "WARN", color: "bg-amber-100 text-amber-800" },
        error: { label: "ERROR", color: "bg-red-100 text-red-800" },
        skip: { label: "SKIP", color: "bg-gray-100 text-gray-600" }
      };
      var sm = statusMap[r.status] || { label: r.status.toUpperCase(), color: "bg-gray-100 text-gray-600" };
      var statusBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ' + sm.color + '">' + sm.label + '</span>';

      var suggestion = r.suggestion
        ? '<div class="mt-1 text-indigo-600 font-medium">\u2192 Better match: <span class="font-mono">' + esc(r.suggestion) + '</span></div>'
        : "";

      html += '<tr class="' + rowClass + '">' +
        '<td class="px-4 py-3">' + typeBadge + '</td>' +
        '<td class="px-4 py-3 font-mono text-xs text-gray-700 break-all">' + esc(r.from) + '</td>' +
        '<td class="px-4 py-3 font-mono text-xs text-gray-700 break-all">' + (r.to ? esc(r.to) : '<span class="text-gray-400">\u2014</span>') + '</td>' +
        '<td class="px-4 py-3">' + statusBadge + '</td>' +
        '<td class="px-4 py-3 text-xs text-gray-600"><span>' + esc(r.message) + '</span>' + suggestion + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }
});

import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import pdf from "pdf-parse";

const app = express();
const PORT = process.env.PORT || 3000;

// Fix __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(express.json({ limit: "25mb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = [
        undefined,
        null,
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000"
      ];

      if (!origin || allowed.includes(origin)) {
        return cb(null, true);
      }

      return cb(new Error("Not allowed by CORS"));
    }
  })
);

// Serve index.html and frontend files
app.use(express.static(__dirname));

// Health check route
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "citeverify-backend",
    port: PORT
  });
});

// Helper function
async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": "CiteVerify/1.0 (local dev)",
      accept: "application/json",
      ...(opts.headers || {})
    },
    ...opts
  });

  const contentType = resp.headers.get("content-type") || "";
  let data = null;
  let rawText = "";

  if (contentType.includes("application/json")) {
    data = await resp.json().catch(() => null);
  } else {
    rawText = await resp.text().catch(() => "");
  }

  return { ok: resp.ok, status: resp.status, data, rawText };
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "in", "on", "for", "to",
    "with", "from", "by", "at", "via", "paper", "study", "studies",
    "approach", "approaches", "analysis", "method", "methods", "results"
  ]);

  return new Set(
    normalizeText(s)
      .split(" ")
      .filter((t) => t.length >= 3 && !stop.has(t))
  );
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;

  let inter = 0;
  for (const t of aSet) {
    if (bSet.has(t)) inter++;
  }

  const union = aSet.size + bSet.size - inter;
  return union ? inter / union : 0;
}

function extractDOI(s) {
  const m = String(s || "").match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return m ? m[0] : "";
}

function extractYear(s) {
  const m = String(s || "").match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : "";
}

// Analyze PDF
app.post("/api/analyze-pdf", async (req, res) => {
  try {
    const base64Data = String(req.body?.base64Data || "");

    if (!base64Data) {
      return res.status(400).json({
        error: { message: "Missing base64Data" }
      });
    }

    const buf = Buffer.from(base64Data, "base64");
    const parsed = await pdf(buf);
    const text = String(parsed?.text || "");

    if (!text.trim()) {
      return res.status(200).json({
        ok: true,
        citations: [],
        warning: "No selectable text found in PDF. It may be scanned."
      });
    }

    const lower = text.toLowerCase();
    const markers = ["references", "bibliography", "works cited"];

    let start = -1;

    for (const m of markers) {
      const idx = lower.lastIndexOf("\n" + m);
      if (idx > start) start = idx;
    }

    if (start < 0) {
      start = Math.max(0, Math.floor(text.length * 0.6));
    }

    const refsText = text.slice(start);

    const lines = refsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const citations = [];
    let cur = "";

    for (const line of lines) {
      const isNew =
        /^\[\d+\]\s+/.test(line) ||
        /^\d+\.\s+/.test(line) ||
        /^[A-Z][a-zA-Z-]+,\s*[A-Z]/.test(line) ||
        /^\(?\d{4}\)?\./.test(line);

      if (isNew && cur) {
        citations.push(cur.trim());
        cur = line;
      } else {
        cur = cur ? cur + " " + line : line;
      }

      if (citations.length >= 60) break;
    }

    if (cur) citations.push(cur.trim());

    const cleaned = citations
      .map((c) => c.replace(/\s+/g, " ").trim())
      .filter((c) => c.length >= 25 && c.length <= 600);

    return res.json({
      ok: true,
      citations: cleaned
    });
  } catch (e) {
    console.error("analyze-pdf error:", e);

    return res.status(500).json({
      error: { message: e?.message || "PDF parse error" }
    });
  }
});

// Crossref Lookup
app.get("/api/lookup/crossref", async (req, res) => {
  try {
    const title = String(req.query.title || "").trim();
    const max = Math.min(10, Math.max(1, Number(req.query.max || 5)));

    if (!title) {
      return res.status(400).json({
        error: { message: "Missing title" }
      });
    }

    const url =
      "https://api.crossref.org/works" +
      `?query.title=${encodeURIComponent(title)}` +
      `&rows=${encodeURIComponent(String(max))}`;

    const r = await fetchJson(url);

    if (!r.ok) {
      return res.status(502).json({
        error: { message: "Crossref error" },
        upstream: r.data || r.rawText
      });
    }

    const items = (r.data?.message?.items || []).map((it) => {
      const isRetracted = Boolean(
        it?.relation?.["is-retracted-by"]?.length ||
        it?.["update-to"]?.find((u) => u.type === "retraction")
      );

      const retractionReason =
        it?.["update-to"]?.find((u) => u.type === "retraction")?.label || null;

      return {
        provider: "crossref",
        title: Array.isArray(it?.title) ? it.title[0] : it?.title,
        year:
          it?.issued?.["date-parts"]?.[0]?.[0] ||
          it?.published?.["date-parts"]?.[0]?.[0] ||
          "",
        source: Array.isArray(it?.["container-title"])
          ? it["container-title"][0]
          : it?.["container-title"],
        doi: it?.DOI || "",
        url: it?.URL || (it?.DOI ? `https://doi.org/${it.DOI}` : ""),
        authors: (it?.author || [])
          .map((a) => [a?.family, a?.given].filter(Boolean).join(", "))
          .join("; "),
        isRetracted,
        retractionReason
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({
      error: { message: e?.message || "Proxy error" }
    });
  }
});

// OpenAlex Lookup
app.get("/api/lookup/openalex", async (req, res) => {
  try {
    const title = String(req.query.title || "").trim();
    const max = Math.min(10, Math.max(1, Number(req.query.max || 5)));

    if (!title) {
      return res.status(400).json({
        error: { message: "Missing title" }
      });
    }

    const url =
      "https://api.openalex.org/works" +
      `?search=${encodeURIComponent(title)}` +
      `&per_page=${encodeURIComponent(String(max))}` +
      `&sort=relevance_score:desc`;

    const r = await fetchJson(url);

    if (!r.ok) {
      return res.status(502).json({
        error: { message: "OpenAlex error" },
        upstream: r.data || r.rawText
      });
    }

    const items = (r.data?.results || []).map((w) => {
      const isRetracted = Boolean(
        w?.concepts?.some(
          (c) => c.display_name?.toLowerCase() === "retraction"
        )
      );

      return {
        provider: "openalex",
        id: w?.id || "",
        title: w?.title || "",
        year: w?.publication_year || "",
        source: w?.host_venue?.display_name || "",
        doi: (w?.doi || "").replace(/^https?:\/\/doi\.org\//i, ""),
        url: w?.landing_page_url || w?.doi || "",
        authors: (w?.authorships || [])
          .map((a) => a?.author?.display_name)
          .filter(Boolean)
          .join("; "),
        isRetracted,
        retractionReason: isRetracted
          ? "Flagged as retracted by OpenAlex"
          : null
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({
      error: { message: e?.message || "Proxy error" }
    });
  }
});

// Semantic Scholar Lookup
app.get("/api/lookup/semanticscholar", async (req, res) => {
  try {
    const title = String(req.query.title || "").trim();
    const max = Math.min(10, Math.max(1, Number(req.query.max || 5)));

    if (!title) {
      return res.status(400).json({
        error: { message: "Missing title" }
      });
    }

    const url =
      "https://api.semanticscholar.org/graph/v1/paper/search" +
      `?query=${encodeURIComponent(title)}` +
      `&limit=${encodeURIComponent(String(max))}` +
      `&fields=${encodeURIComponent(
        "title,year,venue,externalIds,url,authors"
      )}`;

    const r = await fetchJson(url, {
      headers: { accept: "application/json" }
    });

    if (!r.ok) {
      return res.status(502).json({
        error: { message: "Semantic Scholar error" },
        upstream: r.data || r.rawText
      });
    }

    const items = (r.data?.data || []).map((p) => ({
      provider: "semanticscholar",
      title: p?.title || "",
      year: p?.year || "",
      source: p?.venue || "",
      doi: p?.externalIds?.DOI || "",
      url:
        p?.url ||
        (p?.externalIds?.DOI
          ? `https://doi.org/${p.externalIds.DOI}`
          : ""),
      authors: (p?.authors || [])
        .map((a) => a?.name)
        .filter(Boolean)
        .join("; "),
      isRetracted: false
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({
      error: { message: e?.message || "Proxy error" }
    });
  }
});

// arXiv Lookup
app.get("/api/lookup/arxiv", async (req, res) => {
  try {
    const title = String(req.query.title || "").trim();
    const max = Math.min(10, Math.max(1, Number(req.query.max || 5)));

    if (!title) {
      return res.status(400).json({
        error: { message: "Missing title" }
      });
    }

    const url =
      "https://export.arxiv.org/api/query" +
      `?search_query=${encodeURIComponent("ti:" + title)}` +
      `&start=0&max_results=${encodeURIComponent(String(max))}`;

    const resp = await fetch(url, {
      headers: { "user-agent": "CiteVerify/1.0 (local dev)" }
    });

    const xml = await resp.text();

    if (!resp.ok) {
      return res.status(502).json({
        error: { message: "arXiv error" },
        upstream: xml
      });
    }

    const entries = xml.split("<entry>").slice(1);

    const items = entries.map((chunk) => {
      const t = (chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "")
        .replace(/\s+/g, " ")
        .trim();

      const y = chunk.match(/<published>(\d{4})-/)?.[1] || "";
      const link = chunk.match(/<id>([^<]+)<\/id>/)?.[1] || "";

      const authors = [...chunk.matchAll(/<name>([^<]+)<\/name>/g)]
        .map((m) => m[1])
        .join("; ");

      return {
        provider: "arxiv",
        title: t,
        year: y,
        source: "arXiv",
        doi: "",
        url: link,
        authors,
        isRetracted: false
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({
      error: { message: e?.message || "Proxy error" }
    });
  }
});

// Keyword Search
app.get("/api/keyword-search", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();
    const max = Math.min(20, Math.max(1, Number(req.query.max || 8)));
    const year = String(req.query.year || "all").trim();

    if (!query) {
      return res.status(400).json({
        error: { message: "Missing query" }
      });
    }

    const oaUrl =
      "https://api.openalex.org/works" +
      `?search=${encodeURIComponent(query)}` +
      `&per_page=${encodeURIComponent(String(max))}` +
      `&sort=relevance_score:desc`;

    const oa = await fetchJson(oaUrl);

    let items = [];

    if (oa.ok) {
      const results = Array.isArray(oa.data?.results)
        ? oa.data.results
        : [];

      items = results.map((w, idx) => ({
        title: w?.title || "",
        year: w?.publication_year || "",
        source: w?.host_venue?.display_name || "",
        doi: (w?.doi || "").replace(/^https?:\/\/doi\.org\//i, ""),
        url: w?.landing_page_url || w?.doi || "",
        authors: (w?.authorships || [])
          .map((a) => a?.author?.display_name)
          .filter(Boolean)
          .join("; "),
        relevance: Math.max(60, 100 - idx * 5)
      }));
    }

    if (!items.length) {
      const crUrl =
        "https://api.crossref.org/works" +
        `?query=${encodeURIComponent(query)}` +
        `&rows=${encodeURIComponent(String(max))}`;

      const cr = await fetchJson(crUrl);

      if (!cr.ok) {
        return res.status(502).json({
          error: { message: "Keyword search failed" },
          upstream: {
            openalex: oa.data || oa.rawText,
            crossref: cr.data || cr.rawText
          }
        });
      }

      const crItems = Array.isArray(cr.data?.message?.items)
        ? cr.data.message.items
        : [];

      items = crItems.map((it, idx) => ({
        title: Array.isArray(it?.title) ? it.title[0] : it?.title || "",
        year: it?.issued?.["date-parts"]?.[0]?.[0] || "",
        source: Array.isArray(it?.["container-title"])
          ? it["container-title"][0]
          : it?.["container-title"] || "",
        doi: it?.DOI || "",
        url: it?.URL || (it?.DOI ? `https://doi.org/${it.DOI}` : ""),
        authors: (it?.author || [])
          .map((a) => [a?.family, a?.given].filter(Boolean).join(", "))
          .join("; "),
        relevance: Math.max(55, 90 - idx * 6)
      }));
    }

    if (year && year !== "all") {
      const minY = Number(year);

      if (Number.isFinite(minY) && minY > 0) {
        items = items.filter((x) => {
          const y = Number(x.year);
          return Number.isFinite(y) ? y >= minY : true;
        });
      }
    }

    return res.json({
      ok: true,
      items: items.slice(0, max)
    });
  } catch (e) {
    return res.status(500).json({
      error: { message: e?.message || "Keyword search error" }
    });
  }
});

// Citation Corrector
app.post("/api/correct-citation", async (req, res) => {
  try {
    const citation = String(req.body?.citation || "").trim();
    const max = Math.min(10, Math.max(1, Number(req.body?.max || 5)));

    if (!citation) {
      return res.status(400).json({
        error: { message: "Missing citation" }
      });
    }

    const doiHint = extractDOI(citation);
    const yearHint = extractYear(citation);
    const citeTokens = tokenSet(citation);

    let candidates = [];

    if (doiHint) {
      const cr = await fetchJson(
        `https://api.crossref.org/works/${encodeURIComponent(doiHint)}`
      );

      if (cr.ok && cr.data?.message) {
        const it = cr.data.message;

        candidates.push({
          provider: "crossref",
          title: Array.isArray(it?.title) ? it.title[0] : it?.title || "",
          year: it?.issued?.["date-parts"]?.[0]?.[0] || "",
          venue: Array.isArray(it?.["container-title"])
            ? it["container-title"][0]
            : it?.["container-title"] || "",
          doi: it?.DOI || doiHint,
          url: it?.URL || (it?.DOI ? `https://doi.org/${it.DOI}` : ""),
          authors: (it?.author || [])
            .map((a) => [a?.family, a?.given].filter(Boolean).join(", "))
            .join("; ")
        });
      }

      const oa = await fetchJson(
        `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(
          doiHint
        )}`
      );

      if (oa.ok && oa.data) {
        const w = oa.data;

        candidates.push({
          provider: "openalex",
          title: w?.title || "",
          year: w?.publication_year || "",
          venue: w?.host_venue?.display_name || "",
          doi:
            (w?.doi || "").replace(/^https?:\/\/doi\.org\//i, "") ||
            doiHint,
          url: w?.landing_page_url || w?.doi || "",
          authors: (w?.authorships || [])
            .map((a) => a?.author?.display_name)
            .filter(Boolean)
            .join("; ")
        });
      }
    }

    if (!candidates.length) {
      const queryText =
        citation.length > 180 ? citation.slice(0, 180) : citation;

      const oaUrl =
        `https://api.openalex.org/works?search=${encodeURIComponent(
          queryText
        )}` +
        `&per_page=${encodeURIComponent(String(max))}` +
        `&sort=relevance_score:desc`;

      const oa = await fetchJson(oaUrl);

      if (oa.ok) {
        for (const w of oa.data?.results || []) {
          candidates.push({
            provider: "openalex",
            title: w?.title || "",
            year: w?.publication_year || "",
            venue: w?.host_venue?.display_name || "",
            doi: (w?.doi || "").replace(/^https?:\/\/doi\.org\//i, ""),
            url: w?.landing_page_url || w?.doi || "",
            authors: (w?.authorships || [])
              .map((a) => a?.author?.display_name)
              .filter(Boolean)
              .join("; ")
          });
        }
      }

      const crUrl =
        `https://api.crossref.org/works?query=${encodeURIComponent(
          queryText
        )}` + `&rows=${encodeURIComponent(String(max))}`;

      const cr = await fetchJson(crUrl);

      if (cr.ok) {
        for (const it of cr.data?.message?.items || []) {
          candidates.push({
            provider: "crossref",
            title: Array.isArray(it?.title) ? it.title[0] : it?.title || "",
            year: it?.issued?.["date-parts"]?.[0]?.[0] || "",
            venue: Array.isArray(it?.["container-title"])
              ? it["container-title"][0]
              : it?.["container-title"] || "",
            doi: it?.DOI || "",
            url: it?.URL || (it?.DOI ? `https://doi.org/${it.DOI}` : ""),
            authors: (it?.author || [])
              .map((a) => [a?.family, a?.given].filter(Boolean).join(", "))
              .join("; ")
          });
        }
      }
    }

    const scored = candidates
      .map((c) => {
        const titleTokens = tokenSet(c.title);

        let score = 0;
        score += 0.7 * jaccard(citeTokens, titleTokens);

        if (yearHint && c.year && String(c.year) === String(yearHint)) {
          score += 0.15;
        }

        if (c.doi) {
          score += 0.1;
        }

        score = Math.max(0, Math.min(1, score));

        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, max);

    return res.json({
      ok: true,
      original: citation,
      candidates: scored
    });
  } catch (e) {
    console.error("correct-citation error:", e);

    return res.status(500).json({
      error: { message: e?.message || "Corrector error" }
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`CiteVerify backend running on http://localhost:${PORT}`);
});
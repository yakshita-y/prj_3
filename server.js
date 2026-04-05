import express from "express";
import cors from "cors";
import pdfParse from "pdf-parse";

const app = express();

// Allow Live Server origins
app.use(
  cors({
    origin: ["http://127.0.0.1:5500", "http://localhost:5500"]
  })
);

app.use(express.json({ limit: "40mb" }));

// Health check
app.get("/health", (_, res) => res.json({ ok: true }));

function base64ToBuffer(base64Data) {
  return Buffer.from(base64Data, "base64");
}

function normalizeText(t) {
  return String(t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findReferencesSection(fullText) {
  const text = normalizeText(fullText);
  const lower = text.toLowerCase();

  // find start of references section
  const headings = ["references", "bibliography", "works cited", "reference"];
  let start = -1;

  for (const h of headings) {
    const idx = lower.indexOf("\n" + h);
    if (idx !== -1) { start = idx + 1; break; }
  }
  if (start === -1) {
    for (const h of headings) {
      const idx = lower.indexOf(h);
      if (idx !== -1) { start = idx; break; }
    }
  }

  if (start === -1) return text; // fallback: whole text

  const refs = text.slice(start);

  // stop at common ending sections
  const endHeadings = ["\nappendix", "\nacknowledg", "\nsupplement", "\nfigure", "\ntable"];
  const refsLower = refs.toLowerCase();

  let end = refs.length;
  for (const eh of endHeadings) {
    const idx = refsLower.indexOf(eh);
    if (idx !== -1) end = Math.min(end, idx);
  }

  return refs.slice(0, end).trim();
}

function splitCitations(refText) {
  const block = normalizeText(refText);

  // split by blank lines, and join line-wrapped citations
  const chunks = block
    .split(/\n\s*\n/g)
    .map(s => s.replace(/\n+/g, " ").trim())
    .filter(Boolean);

  const results = [];
  for (const c of chunks) {
    // If chunk contains many numbered refs, split them
    const manyNumbered = c.match(/(?:^|\s)(\[\d+\]|\d+\.)\s+/g);
    if (manyNumbered && manyNumbered.length >= 2) {
      const parts = c
        .split(/(?=(?:\[\d+\]|\d+\.)\s+)/g)
        .map(p => p.trim())
        .filter(Boolean);
      results.push(...parts);
    } else {
      results.push(c);
    }
  }

  // drop very short noise
  return results.filter(x => x.length >= 20);
}

app.post("/api/analyze-pdf", async (req, res) => {
  try {
    const { base64Data } = req.body || {};
    if (!base64Data) {
      return res.status(400).json({ error: { message: "Missing base64Data" } });
    }

    const buf = base64ToBuffer(base64Data);
    const parsed = await pdfParse(buf);
    const text = parsed?.text || "";

    if (!text.trim()) {
      return res.json({
        citations: [],
        note: "No selectable text found. If the PDF is scanned (image-only), OCR is required."
      });
    }

    const refs = findReferencesSection(text);
    const rawCits = splitCitations(refs);

    // Return citations as objects (frontend expects item.raw at least)
    const citations = rawCits.map(raw => ({
      authors: "",
      title: "",
      journal: "",
      year: "",
      raw
    }));

    return res.json({
      citations,
      extractedCount: citations.length
    });

  } catch (err) {
    return res.status(500).json({
      error: { message: err?.message || "Server error" }
    });
  }
});

app.listen(3000, () => {
  console.log("✅ Server running at http://localhost:3000");
});
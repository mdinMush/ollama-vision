import express from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fromPath as pdfToPicFromPath } from 'pdf2pic';
import { z } from 'zod';

const app = express();
app.use(express.json({ limit: '20mb' }));

// --- Multer setup for PDF upload
const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if ((file.mimetype || '').includes('pdf') || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
    else cb(new Error('Only PDF files are allowed.'));
  },
});

// ---- Zod schema for the data we want to extract (customize to your doc)
const ExtractedDataSchema = z.object({
  documentType: z.string().optional(),
  invoiceNumber: z.string().optional(),
  date: z.string().optional(),
  vendor: z.string().optional(),
  buyer: z.string().optional(),
  total: z.string().optional(),
  currency: z.string().optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().optional(),
        quantity: z.string().optional(),
        unitPrice: z.string().optional(),
        amount: z.string().optional(),
      })
    )
    .optional(),
  meta: z
    .object({
      pagesProcessed: z.number().optional(),
    })
    .optional(),
});

// ---- Helper: call Ollama chat with images
async function callOllamaVision({ model = 'llama3.2-vision', prompt, base64Images }) {
  // Ollama expects images as base64 without prefix, in "images" on the message
  const messages = [
    {
      role: 'system',
      content:
        'You are a precise data-extraction engine. Only output STRICT JSON that matches the requested schema. No markdown fences, no commentary.',
    },
    {
      role: 'user',
      content: `${prompt}\n\nReturn ONLY JSON.`,
      images: base64Images, // array of base64 strings
    },
  ];

  const { data } = await axios.post(
    'http://localhost:11434/api/chat',
    { model, messages, options: { temperature: 0 } },
    { timeout: 1000 * 60 * 5 } // 5 minutes for big PDFs
  );

//    let ollama_messages = [
//           {
//             role: "system",
//             content: entheogpt_ollama, 

//       },
         
//         ];
        
      
//         let body = {
//           model: "dolphin-llama3",
//           prompt: ollama_messages
//             .map((msg) => `${msg.role}: ${msg.content}`)
//             .join("\n\n"),
//           stream: false,
//         };

//        let resp = await axios.post(ollamaUrl, body, {});

  // Ollama streams tokens by default when using /api/generate; /api/chat returns final JSON in `message.content`
  // Some builds can stream; ensure we get final `message`:
  const content =
    data?.message?.content ??
    // Fallback if your Ollama returns a list of messages:
    (Array.isArray(data?.messages) ? data.messages.map(m => m.content).join('\n') : '');

  return content?.trim() || '';
}

// ---- Helper: convert a PDF to PNG images and return base64 array (paged)
async function pdfToBase64Pages(pdfPath, { density = 200 } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2img-'));
  const converter = pdfToPicFromPath(pdfPath, {
    density, // DPI; 200–300 is typical for OCR-like extraction
    savePath: tmpDir,
    format: 'png',
    quality: 100,
  });

  // Convert the first N pages; if unknown count, you can try an upper bound
  // pdf2pic has a .bulk method, but we’ll loop until it throws after last page:
  const base64Pages = [];
  for (let page = 1; page <= 9999; page++) {
    try {
      const result = await converter(page, true); // returns { path, base64, ... } when 2nd arg is true
      if (!result?.base64) break;
      base64Pages.push(result.base64);
    } catch (err) {
      // out of pages / done
      break;
    }
  }

  // cleanup images directory
  await fs.remove(tmpDir);
  return base64Pages;
}

// ---- Prompt for the model: describe the schema you want
function buildExtractionPrompt() {
  // Adjust this to your PDF type. Keep it short and strict.
  return `
You will receive 1..N images representing pages of a scanned PDF.
Extract the following fields when present and return STRICT JSON ONLY:

{
  "documentType": string | null,
  "invoiceNumber": string | null,
  "date": string | null,
  "vendor": string | null,
  "buyer": string | null,
  "total": string | null,
  "currency": string | null,
  "lineItems": [
    { "description": string | null, "quantity": string | null, "unitPrice": string | null, "amount": string | null }
  ] | [],
  "meta": { "pagesProcessed": number }
}

Rules:
- If a field is missing, set it to null (or [] for arrays).
- Normalize currency to ISO code if visible (e.g., "USD", "EUR", "PKR").
- Parse totals as they appear; do not invent values.
- Use data across ALL pages to complete the JSON.
`;
}

// ---- Controller: POST /extract
app.post('/extract', upload.single('file'), async (req, res) => {
  const pdfFile = req.file;
  if (!pdfFile) return res.status(400).json({ error: 'No PDF uploaded. Use form field "file".' });

  try {
    // 1) Convert PDF pages to base64 PNGs
    const pages = await pdfToBase64Pages(pdfFile.path, { density: 220 });
    if (!pages.length) throw new Error('Could not render any pages from PDF.');

    // If your PDFs are huge, batch pages to keep payloads smaller:
    const BATCH_SIZE = 6; // tune per your GPU/VRAM and network
    const batches = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      batches.push(pages.slice(i, i + BATCH_SIZE));
    }

    // 2) Ask the model to extract JSON for ALL pages in one go when small,
    //    otherwise batch and then merge results:
    const prompt = buildExtractionPrompt();

    let merged = {
      documentType: null,
      invoiceNumber: null,
      date: null,
      vendor: null,
      buyer: null,
      total: null,
      currency: null,
      lineItems: [],
      meta: { pagesProcessed: 0 },
    };

    for (const [idx, batch] of batches.entries()) {
      const content = await callOllamaVision({
        prompt: `${prompt}\nBatch ${idx + 1} of ${batches.length}.`,
        base64Images: batch,
      });

      // Enforce JSON-only: try parse, or try to strip non-JSON if needed
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        // naive cleanup if model added stray text
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
          parsed = JSON.parse(content.slice(start, end + 1));
        } else {
          throw new Error('Model did not return valid JSON.');
        }
      }

      const result = ExtractedDataSchema.partial().parse(parsed);

      // 3) Merge strategy: first non-null wins, concatenate lineItems, sum pagesProcessed
      for (const key of ['documentType', 'invoiceNumber', 'date', 'vendor', 'buyer', 'total', 'currency']) {
        if (merged[key] == null && result[key] != null) merged[key] = result[key];
      }
      if (Array.isArray(result.lineItems)) {
        merged.lineItems = [...merged.lineItems, ...result.lineItems];
      }
      merged.meta.pagesProcessed += batch.length;
    }

    // Validate final shape strictly
    const final = ExtractedDataSchema.parse(merged);

    res.json({
      ok: true,
      pages: pages.length,
      data: final,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Extraction failed',
    });
  } finally {
    // cleanup uploaded file
    if (req.file?.path) {
      try {
        await fs.remove(req.file.path);
      } catch {}
    }
  }
});

// Basic health route
app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 6000;

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));

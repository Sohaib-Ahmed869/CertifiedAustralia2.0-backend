/**
 * Invoice Parser Service — DEXT-style automatic invoice data extraction.
 *
 * Pipeline:
 *   1. Extract text from the uploaded PDF (pdf-parse).
 *   2. Ask OpenAI (gpt-4o-mini) to return structured JSON for the invoice fields.
 *   3. Fall back to regex heuristics when there is no OPENAI_API_KEY, the LLM
 *      call fails, or a field comes back empty.
 *
 * Returns a normalised object the frontend can drop straight into the
 * "Upload RTO Invoice" form. Dates are normalised to ISO (YYYY-MM-DD) so they
 * bind directly to <input type="date">. Nothing is persisted here — the caller
 * decides what to do with the result.
 *
 * There are no official SDKs in this codebase; OpenAI is called via native
 * fetch, mirroring chatbotService.js.
 */

// Require the library implementation directly to skip pdf-parse's index.js
// debug harness (which tries to read a bundled test PDF when run standalone).
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Pull the raw text out of a PDF buffer. Returns '' for non-PDFs or when the
 * PDF has no embedded text layer (i.e. a scanned image — no OCR here).
 */
const extractText = async (buffer, mimeType = '') => {
  const isPdf = mimeType.includes('pdf') || (buffer && buffer.slice(0, 5).toString() === '%PDF-');
  if (!isPdf) return '';
  try {
    const data = await pdfParse(buffer);
    return (data.text || '').trim();
  } catch (err) {
    return '';
  }
};

// ---------------------------------------------------------------------------
// Date normalisation helpers
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Normalise a free-form date string to YYYY-MM-DD, or '' if unparseable.
 * Handles: "27 July 2026", "27 Jul 2026", "July 27, 2026", "27/07/2026",
 * "27-07-2026", "2026-07-27". Assumes day-first for ambiguous numeric dates
 * (AU convention).
 */
const normaliseDate = (input) => {
  if (!input) return '';
  const raw = String(input).trim();
  if (!raw) return '';

  // Already ISO
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // "27 July 2026" / "27 Jul 2026" / "27th July 2026"
  m = raw.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
  }

  // "July 27, 2026" / "Jul 27 2026"
  m = raw.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }

  // "27/07/2026" / "27-07-2026" / "27.07.2026" (day-first)
  m = raw.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  return '';
};

/** Parse a currency/number string like "$1,500.00" → 1500. Returns null if none. */
const parseAmount = (input) => {
  if (input === 0) return 0;
  if (!input) return null;
  const cleaned = String(input).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// LLM extraction (primary)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are an invoice data extraction engine for an Australian RPL training company.
You will be given the raw text of a supplier (RTO) tax invoice addressed to "Certified Australia".
Extract the invoice details and reply with ONLY a JSON object (no markdown, no prose) with these exact keys:
{
  "invoiceNumber": string,        // the supplier's invoice number, e.g. "INV-11102"
  "invoiceDate": string,          // issue date, ISO format YYYY-MM-DD
  "dueDate": string,              // due date, ISO format YYYY-MM-DD
  "amount": number,               // subtotal / net amount before tax
  "taxAmount": number,            // GST / tax amount (0 if none)
  "totalAmount": number,          // total amount due including tax
  "description": string,          // the line-item description (student name + qualification)
  "rtoName": string,              // the supplier/RTO business name (the "from", NOT "Certified Australia")
  "reference": string,            // the invoice Reference field verbatim if present, else ""
  "studentName": string,          // the student's name if present in the description/reference, else ""
  "confidence": number            // 0-100, your confidence in the overall extraction
}
Rules:
- The bill-to party is always "Certified Australia" — never return that as rtoName.
- amount is the SUBTOTAL (before tax); totalAmount is the grand total. If only one figure exists, set both to it.
- Use null for a numeric field you genuinely cannot find. Use "" for a string you cannot find.
- Dates MUST be YYYY-MM-DD. Convert "27 July 2026" to "2026-07-27".
- Return valid JSON only.`;

const extractWithLLM = async (text) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: `Invoice text:\n"""\n${text.slice(0, 6000)}\n"""` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    return {
      invoiceNumber: (parsed.invoiceNumber || '').toString().trim(),
      invoiceDate: normaliseDate(parsed.invoiceDate),
      dueDate: normaliseDate(parsed.dueDate),
      amount: parseAmount(parsed.amount),
      taxAmount: parseAmount(parsed.taxAmount),
      totalAmount: parseAmount(parsed.totalAmount),
      description: (parsed.description || '').toString().trim(),
      rtoName: (parsed.rtoName || '').toString().trim(),
      reference: (parsed.reference || '').toString().trim(),
      studentName: (parsed.studentName || '').toString().trim(),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 70,
    };
  } catch (err) {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Regex heuristic extraction (fallback / gap-filler)
// ---------------------------------------------------------------------------

const firstMatch = (text, re) => {
  const m = text.match(re);
  return m ? m[1].trim() : '';
};

const extractWithRegex = (text) => {
  const out = {
    invoiceNumber: '', invoiceDate: '', dueDate: '', amount: null,
    taxAmount: null, totalAmount: null, description: '', rtoName: '',
    reference: '', studentName: '', confidence: 40,
  };
  if (!text) { out.confidence = 0; return out; }

  // Invoice number — value on its own line after an "Invoice number" label, or "INV-1234" anywhere.
  out.invoiceNumber =
    firstMatch(text, /invoice\s*(?:number|no\.?|#)\s*[:#]?\s*\n?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i) ||
    firstMatch(text, /\b(INV[-\s]?\d{3,})\b/i);

  // Dates — labelled "Issue date" / "Invoice date" and "Due date".
  const dateBody = /([0-9]{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,}\.?\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[/\-.][0-9]{1,2}[/\-.][0-9]{2,4}|[A-Za-z]{3,}\.?\s+[0-9]{1,2},?\s+[0-9]{4})/;
  out.invoiceDate = normaliseDate(firstMatch(text, new RegExp('(?:issue|invoice)\\s*date\\s*[:]?\\s*\\n?\\s*' + dateBody.source, 'i')));
  out.dueDate = normaliseDate(firstMatch(text, new RegExp('due\\s*date\\s*[:]?\\s*\\n?\\s*' + dateBody.source, 'i')));

  // Amounts — Subtotal → amount, Total/Amount due → totalAmount.
  const money = /\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/;
  out.amount = parseAmount(firstMatch(text, new RegExp('sub\\s*total\\s*[:]?\\s*' + money.source, 'i')));
  out.totalAmount =
    parseAmount(firstMatch(text, new RegExp('(?:^|\\n)\\s*total\\s*[:]?\\s*' + money.source, 'i'))) ||
    parseAmount(firstMatch(text, new RegExp('amount\\s*due\\s*[:]?\\s*' + money.source, 'i')));
  // GST/Tax amount if explicitly labelled with a dollar figure.
  out.taxAmount = parseAmount(firstMatch(text, new RegExp('(?:gst|tax)\\s*(?:amount)?\\s*[:]?\\s*' + money.source, 'i')));

  // Reference line (may wrap across two lines — collapse to a single line).
  out.reference = firstMatch(text, /reference\s*[:]?\s*\n?\s*([^\n]+(?:\n[^\n]+)?)/i)
    .replace(/\s*view online\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
};

// ---------------------------------------------------------------------------
// Merge + orchestration
// ---------------------------------------------------------------------------

/** Prefer the LLM value; fall back to regex per-field when the LLM left it blank. */
const mergeResults = (llm, regex) => {
  const pick = (a, b) => (a !== null && a !== undefined && a !== '' ? a : b);
  const merged = {
    invoiceNumber: pick(llm?.invoiceNumber, regex.invoiceNumber),
    invoiceDate: pick(llm?.invoiceDate, regex.invoiceDate),
    dueDate: pick(llm?.dueDate, regex.dueDate),
    amount: pick(llm?.amount, regex.amount),
    taxAmount: pick(llm?.taxAmount ?? null, regex.taxAmount),
    totalAmount: pick(llm?.totalAmount, regex.totalAmount),
    description: pick(llm?.description, regex.description),
    rtoName: pick(llm?.rtoName, regex.rtoName),
    reference: pick(llm?.reference, regex.reference),
    studentName: pick(llm?.studentName, regex.studentName),
  };

  // Sensible cross-fills.
  if (merged.amount == null && merged.totalAmount != null) merged.amount = merged.totalAmount;
  if (merged.totalAmount == null && merged.amount != null) {
    merged.totalAmount = merged.amount + (merged.taxAmount || 0);
  }
  if (merged.taxAmount == null) merged.taxAmount = 0;

  merged.confidence = llm ? (llm.confidence ?? 70) : regex.confidence;
  merged.source = llm ? 'ai' : 'heuristic';
  return merged;
};

/**
 * Parse an invoice buffer end to end.
 * @returns {Promise<object>} normalised extracted fields + { raw, confidence, source }
 */
const parseInvoiceBuffer = async (buffer, mimeType = '') => {
  const text = await extractText(buffer, mimeType);

  if (!text) {
    // No text layer (scanned image / unsupported) — nothing to extract.
    return {
      invoiceNumber: '', invoiceDate: '', dueDate: '', amount: null,
      taxAmount: 0, totalAmount: null, description: '', rtoName: '',
      reference: '', studentName: '', confidence: 0, source: 'none',
      raw: '',
      warning: 'Could not read text from this file. It may be a scanned image — please enter the details manually.',
    };
  }

  const regex = extractWithRegex(text);
  const llm = await extractWithLLM(text);
  const merged = mergeResults(llm, regex);
  merged.raw = text;
  return merged;
};

module.exports = {
  parseInvoiceBuffer,
  extractText,
  normaliseDate,
  parseAmount,
};

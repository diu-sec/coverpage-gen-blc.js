import {
    PDFDocument,
    StandardFonts,
    rgb
} from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";



/**
 * Normalizes any supported PDF source into a Uint8Array.
 * Accepts: a URL string, a File/Blob object, an ArrayBuffer, or a Uint8Array.
 * @param {string|File|Blob|ArrayBuffer|Uint8Array} source
 * @returns {Promise<Uint8Array>}
 */
async function _loadPdfBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  if (typeof source === "string") {
    const res = await fetch(source);
    if (!res.ok) throw new Error("Could not fetch PDF: HTTP " + res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error("Unsupported PDF source type");
}

/**
 * Hard-wraps text into fixed-width lines (character count based — correct
 * for monospace fonts, where every character has the same width).
 * Preserves existing line breaks and blank lines.
 * @param {string} text
 * @param {number} maxCharsPerLine
 * @returns {string[]}
 */
function _wrapMonospaceText(text, maxCharsPerLine) {
  const lines = [];
  // Normalize line endings once, then split on paragraph breaks.
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  for (const para of paragraphs) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    for (let i = 0; i < para.length; i += maxCharsPerLine) {
      lines.push(para.slice(i, i + maxCharsPerLine));
    }
  }
  return lines;
}

/**
 * Appends a large block of monospace text to a PDFDocument as one or more
 * new pages (as many as needed). Designed to handle large strings (tested
 * conceptually up to several MB) efficiently:
 *   - line-wrapping is done with plain string slicing (fast, O(n))
 *   - each page is drawn with a SINGLE page.drawText() call using pdf-lib's
 *     built-in multi-line support (splits on "\n" internally), instead of
 *     one drawText() call per line — this is what keeps thousands of lines
 *     fast to render.
 * Note: for very large input (multi-MB), this still runs synchronously on
 * the main thread and can take a few seconds and produce a large PDF (hundreds
 * of pages) — show a loading indicator in your UI while it runs.
 *
 * @param {PDFDocument} pdfDoc
 * @param {string} text - The text to append. Can be very large (MBs).
 * @param {Object} [opts]
 * @param {number} [opts.fontSize=9]
 * @param {number} [opts.lineHeight=11]
 * @param {number} [opts.margin=50] - Margin on all sides, in points.
 * @param {[number, number]} [opts.pageSize] - [width, height] for new pages; defaults to the size of the last existing page.
 * @returns {Promise<void>}
 */
async function _appendMonospacePages(pdfDoc, text, opts) {
  opts = opts || {};
  const fontSize = opts.fontSize ?? 9;
  const lineHeight = opts.lineHeight ?? 11;
  const margin = opts.margin ?? 50;

  const font = await pdfDoc.embedFont(StandardFonts.Courier);

  const existingPages = pdfDoc.getPages();
  const lastPage = existingPages[existingPages.length - 1];
  const [pageWidth, pageHeight] = opts.pageSize || [lastPage.getWidth(), lastPage.getHeight()];

  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;

  // Courier is monospaced: every character has identical width at a given size.
  const charWidth = font.widthOfTextAtSize("0", fontSize);
  const maxCharsPerLine = Math.max(1, Math.floor(usableWidth / charWidth));
  const linesPerPage = Math.max(1, Math.floor(usableHeight / lineHeight));

  const lines = _wrapMonospaceText(text, maxCharsPerLine);

  for (let i = 0; i < lines.length; i += linesPerPage) {
    const pageLines = lines.slice(i, i + linesPerPage);
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawText(pageLines.join("\n"), {
      x: margin,
      y: pageHeight - margin - fontSize, // top-aligned first line
      size: fontSize,
      lineHeight,
      font,
      color: rgb(0, 0, 0)
    });
  }
}

/**
 * Fills cover-page fields onto a PDF and returns the result as binary data.
 *
 * Layout: two columns for every field EXCEPT Student Name and Student ID,
 * which are drawn full-width. Everything is written into the blank space
 * in the bottom 30% of the page (auto-detected from the page's own height,
 * so it adapts if the source PDF isn't a standard Letter size).
 *
 * @param {string|File|Blob|ArrayBuffer|Uint8Array} pdfSource - URL, File, Blob, ArrayBuffer, or Uint8Array of the source PDF.
 * @param {Object} fields - Field values (all optional, blank ones are skipped).
 * @param {string} [fields.Semester]
 * @param {string} [fields["Student Name"]]
 * @param {string} [fields["Student ID"]]
 * @param {string} [fields.Batch]
 * @param {string} [fields.Section]
 * @param {string} [fields["Course Code"]]
 * @param {string} [fields["Course Name"]]
 * @param {string} [fields["Course Teacher Name"]]
 * @param {string} [fields.Designation]
 * @param {string} [fields["Submission Date"]]
 * @param {Object} [options]
 * @param {number} [options.pageIndex=0] - Which page to write onto.
 * @param {number} [options.bottomZonePercent=0.30] - Fraction of page height (from the bottom) treated as the writable blank zone.
 * @param {number} [options.startX=70] - Left margin, in points.
 * @param {number} [options.rightMargin=70] - Right margin, in points.
 * @param {number} [options.lineHeight=24] - Vertical spacing between lines.
 * @param {number} [options.fontSize=11]
 * @param {string} [options.appendText] - Large monospace text block (can be MBs) appended as new page(s) after the cover page.
 * @param {number} [options.appendFontSize=9] - Font size for the appended monospace pages.
 * @param {number} [options.appendLineHeight=11] - Line height for the appended monospace pages.
 * @param {number} [options.appendMargin=50] - Page margin for the appended monospace pages.
 * @returns {Promise<{bytes: Uint8Array, blob: Blob}>} Raw binary result.
 */
export async function pdfAddCoverFields(pdfSource, fields, options) {
  options = options || {};
  const pageIndex = options.pageIndex ?? 0;
  const startX = options.startX ?? 70;
  const rightMargin = options.rightMargin ?? 70;
  const lineHeight = options.lineHeight ?? 24;
  const size = options.fontSize ?? 11;
  const bottomZonePercent = options.bottomZonePercent ?? 0.30;

  const pdfBytes = await _loadPdfBytes(pdfSource);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const page = pdfDoc.getPage(pageIndex);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();

  // Writable zone = bottom `bottomZonePercent` of the page (the blank area).
  const zoneTop = pageHeight * bottomZonePercent;
  const zoneBottomMargin = 30; // keep clear of the very edge of the page
  const topBuffer = 20;        // keep clear of the top of the zone
  let y = zoneTop - topBuffer;

  // Two-column geometry
  const colGap = 20;
  const colWidth = (pageWidth - startX - rightMargin - colGap) / 2;
  const col1X = startX;
  const col2X = startX + colWidth + colGap;

  function drawField(label, value, x) {
    page.drawText(label + ":", { x, y, size, font: fontBold, color: rgb(0, 0, 0) });
    if (value) {
      const offset = fontBold.widthOfTextAtSize(label + ":  ", size);
      page.drawText(String(value), { x: x + offset, y, size, font, color: rgb(0, 0, 0) });
    }
  }

  function fullWidthRow(label, value) {
    drawField(label, value, col1X);
    y -= lineHeight;
  }

  function twoColumnRow(labelA, valueA, labelB, valueB) {
    drawField(labelA, valueA, col1X);
    drawField(labelB, valueB, col2X);
    y -= lineHeight;
  }

  // Full-width: Student Name and Student ID
  fullWidthRow("Student Name", fields["Student Name"]);
  fullWidthRow("Student ID", fields["Student ID"]);

  // Two-column: everything else
  twoColumnRow("Semester", fields.Semester, "Submission Date", fields["Submission Date"]);
  twoColumnRow("Batch", fields.Batch, "Section", fields.Section);
  twoColumnRow("Course Code", fields["Course Code"], "Course Name", fields["Course Name"]);
  twoColumnRow("Course Teacher Name", fields["Course Teacher Name"], "Designation", fields.Designation);

  if (y < zoneBottomMargin) {
    console.warn("pdfAddCoverFields: content may run below the safe bottom margin — consider a larger bottomZonePercent or smaller lineHeight.");
  }

  // Append large monospace text block as new page(s), if provided.
  if (options.appendText) {
    await _appendMonospacePages(pdfDoc, options.appendText, {
      fontSize: options.appendFontSize ?? 9,
      lineHeight: options.appendLineHeight ?? 11,
      margin: options.appendMargin ?? 50,
      pageSize: [pageWidth, pageHeight]
    });
  }

  const bytes = await pdfDoc.save();      // Uint8Array — raw binary
  const blob = new Blob([bytes], { type: "application/pdf" }); // binary Blob

  return { bytes, blob };
}

/**
 * Convenience helper: triggers a browser download of the binary result.
 * Optional — only call this if you actually want a download; pdfAddCoverFields
 * itself never downloads anything on its own.
 * @param {Blob} blob
 * @param {string} [filename="cover_page_filled.pdf"]
 */
function pdfDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "cover_page_filled.pdf";
  a.click();
  URL.revokeObjectURL(url);
}

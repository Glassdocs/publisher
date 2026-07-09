// Shared helpers for the inject-*.mjs deploy-time scripts.
//
// Every injector follows the same shape:
//   1. Detect whether the page qualifies (has a relevant element).
//   2. Render an inline payload (CSS / script / HTML).
//   3. Either replace an existing payload (matched by START/END
//      comment markers) or insert a fresh one at an anchor.
//   4. On opt-out marker or "no longer qualifies", strip any prior
//      payload so the file stays minimal.
//
// Before this lib, escape helpers + the strip / replace-or-insert
// regex patterns were copy-pasted across inject-toc, -codeblocks,
// -callouts, -prev-next, -branding, and -page-meta. Now they live
// here once. Per-script payload + anchor logic stays in each script.

// ── Escape helpers ──────────────────────────────────────────────────

/** Escape for HTML element content (between tags). */
export const escapeText = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** Escape for HTML attribute values (inside quotes). */
export const escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#x27;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** Escape a string for safe inclusion in a RegExp source. */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Marker-block injection ──────────────────────────────────────────

/**
 * Build a regex that matches a marker block plus optional surrounding
 * newlines (so a strip leaves a clean file with no orphan blank line).
 * Used by `stripBlockBetween`.
 */
function blockWithPaddingRe(start, end) {
  return new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
}

/**
 * Build a regex that matches a marker block exactly (no padding).
 * Used by `replaceOrInsertBlock` so the replacement preserves the
 * surrounding newlines from the original injection.
 */
function blockExactRe(start, end) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

/**
 * Remove a `<!-- @marker --> ... <!-- /@marker -->` block from html
 * if present. Returns the html unchanged when no block exists.
 * Strips one surrounding newline on each side so the file doesn't
 * end up with a blank line where the block used to be.
 */
export function stripBlockBetween(html, start, end) {
  return html.replace(blockWithPaddingRe(start, end), '');
}

/**
 * Replace an existing marker block with `payload`, OR if no block
 * exists yet, insert `payload` using the anchor regex. The insertion
 * places the payload AFTER the anchor match by default; pass
 * `before: true` to insert before instead.
 *
 * Returns { changed, html }. `changed` is false when the resulting
 * html is byte-identical to the input (idempotent rerun, or no anchor
 * found and no existing block).
 *
 * `payload` MUST already include the START/END markers - the caller
 * controls the exact shape (this function just splices it in).
 */
export function replaceOrInsertBlock(html, start, end, payload, anchorRe, opts = {}) {
  const blockRe = blockExactRe(start, end);
  if (blockRe.test(html)) {
    const replaced = html.replace(blockRe, payload);
    return { changed: replaced !== html, html: replaced };
  }
  if (!anchorRe.test(html)) {
    return { changed: false, html };
  }
  const before = opts.before === true;
  const inserted = html.replace(anchorRe, (m) =>
    before ? `${payload}\n${m}` : `${m}\n${payload}`,
  );
  return { changed: inserted !== html, html: inserted };
}

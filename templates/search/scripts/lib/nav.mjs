// Shared NavConfig parser, validator, renderer, and linter.
//
// Consumed by:
//   - templates/search/scripts/inject-nav.mjs (deploy-time injector)
//   - extension/src/content/content.ts (parses /nav.json fetched from docs site)
//   - extension/src/adapters/openai.ts  (validates model-proposed nav edits)
//
// Single source of truth - no drift between deploy-time and extension-time
// validation. TypeScript consumers get types from the sibling nav.d.ts.

const isString = (v) => typeof v === 'string';

// Renderer only handles one level of nesting (top-level items + their
// direct children). Validating arbitrary depth would let schema authors
// write trees the renderer silently truncates - reject grandchildren
// up front so the failure is loud at deploy time, not on the rendered
// page.
function isLeafChild(value) {
  if (value == null || typeof value !== 'object') return false;
  if (typeof value.label !== 'string') return false;
  if (typeof value.href !== 'string') return false;
  // A child may not itself have children. (If we ever support deeper
  // nesting, drop this check and update renderItems to recurse.)
  if (value.children !== undefined) return false;
  return true;
}

function isNavItem(value) {
  if (value == null || typeof value !== 'object') return false;
  if (typeof value.label !== 'string') return false;
  const hasHref = typeof value.href === 'string';
  const hasChildren = Array.isArray(value.children);
  if (!hasHref && !hasChildren) return false;
  if (hasChildren && !value.children.every(isLeafChild)) return false;
  return true;
}

/**
 * Parse a raw nav.json string. Returns null on any shape violation so the
 * caller can treat "no nav config" uniformly.
 */
export function parseNavConfig(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed == null || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.items)) return null;
  if (!parsed.items.every(isNavItem)) return null;
  const navSkip = Array.isArray(parsed.navSkip)
    ? parsed.navSkip.filter(isString)
    : undefined;
  return { items: parsed.items, navSkip, raw };
}

// `&` must run first so later escapes don't double-encode. Python's
// html.escape(..., quote=True) is our reference output - both must escape
// &, <, >, " and '.
const escapeText = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const escapeAttr = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#x27;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function renderItems(items, activeFile, indent) {
  const out = [];
  for (const item of items) {
    const label = escapeText(item.label);
    if (Array.isArray(item.children)) {
      out.push(`${indent}<span class="nav-drop">`);
      out.push(`${indent}  <span class="nav-drop-trigger">${label}</span>`);
      out.push(`${indent}  <div class="nav-drop-menu">`);
      for (const c of item.children) {
        const active = c.href === activeFile ? ' class="active"' : '';
        out.push(
          `${indent}    <a href="${escapeAttr(c.href)}"${active}>${escapeText(c.label)}</a>`
        );
      }
      out.push(`${indent}  </div>`);
      out.push(`${indent}</span>`);
    } else {
      const active = item.href === activeFile ? ' class="active"' : '';
      out.push(`${indent}<a href="${escapeAttr(item.href)}"${active}>${label}</a>`);
    }
  }
  return out;
}

/**
 * Render the <nav class="topbar-links">...</nav> block with active state
 * set from the current filename.
 */
export function renderNav(items, activeFile) {
  const lines = ['<nav class="topbar-links">'];
  lines.push(...renderItems(items, activeFile, '    '));
  lines.push('  </nav>');
  return lines.join('\n');
}

/** Every href target (leaf + dropdown children), in order. */
export function collectHrefs(items) {
  const out = [];
  for (const item of items) {
    if (typeof item.href === 'string') out.push(item.href);
    if (Array.isArray(item.children)) out.push(...collectHrefs(item.children));
  }
  return out;
}

/**
 * Pages that are NEVER candidates for the topbar regardless of whether
 * they appear in navSkip. These conventions are universal across every
 * docs site: a 404 page is a Cloudflare Pages convention served on
 * any miss, and a sitemap is by definition the index OF the topbar
 * (it lives in the footer or as a deep link, not in the topbar
 * itself). Hardcoding the implicit-skip prevents one new repo from
 * breaking the whole deploy because a fresh-install user forgot to
 * add 404.html to navSkip.
 */
export const IMPLICIT_NAV_SKIP = new Set([
  '404.html',
  'sitemap.html',
  'changelog.html',
]);

/**
 * Two invariants on every build:
 *   - coverage: every page is either in items, in navSkip, or implicit-skip
 *   - targets:  every href resolves to a file
 * Returns an array of error messages; empty means passing.
 */
export function lintNav(pages, config) {
  const items = config.items ?? [];
  const skip = new Set([...(config.navSkip ?? []), ...IMPLICIT_NAV_SKIP]);
  const pageSet = new Set(pages);
  const targets = new Set(collectHrefs(items));
  const errors = [];
  const orphans = [...pageSet].filter((p) => !targets.has(p) && !skip.has(p)).sort();
  if (orphans.length) {
    errors.push(`inject-nav: pages not in nav.json or navSkip: ${orphans.join(', ')}`);
  }
  const broken = [...targets].filter((t) => !pageSet.has(t)).sort();
  if (broken.length) {
    errors.push(`inject-nav: nav.json hrefs with no matching page: ${broken.join(', ')}`);
  }
  return errors;
}

const TOPBAR_LINKS_RE = /<nav class="topbar-links">[\s\S]*?<\/nav>/;

/**
 * Replace the <nav class="topbar-links">...</nav> block with rendered nav.
 * No-op when the page has no such block.
 */
export function injectNav(html, navHtml) {
  if (!TOPBAR_LINKS_RE.test(html)) return html;
  return html.replace(TOPBAR_LINKS_RE, navHtml);
}

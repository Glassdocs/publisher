// Shared site-chrome extraction + active-link setter for HTML generators.
//
// Consumed by generate-sitemap.mjs and generate-changelog.mjs. Kept in sync
// with the Python extract_site_chrome / set_active_link behaviour so dogfood
// runs produce byte-identical output (zero diff) against the Python versions
// during migration.
//
// generate-references does NOT use these - it builds a self-contained page
// under docs/references/ that deliberately doesn't inherit the site topbar.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Read project name, head links, topbar, and footer from docs/index.html.
 * Returns fallback values when index.html is missing so generators never
 * throw on a brand-new KB.
 */
export function extractSiteChrome(docsDir) {
  const index = path.join(docsDir, 'index.html');
  if (!existsSync(index)) {
    return { projectName: 'Project', headHtml: '', topbar: '', footer: '' };
  }
  const html = readFileSync(index, 'utf8');

  const badgeMatch = html.match(/<span class="badge">(.*?)<\/span>/);
  const projectName = badgeMatch ? badgeMatch[1].trim() : 'Project';

  // All <link> tags that are either stylesheet or icon. Ordering is preserved
  // so the regenerated chrome keeps the same <head> order as the source.
  const linkTags = [];
  const linkRe = /<link[^>]+>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (tag.includes('stylesheet') || tag.includes('icon')) linkTags.push(tag);
  }
  const headHtml = linkTags.join('\n');

  const topbarMatch = html.match(/(<header class="topbar">[\s\S]*?<\/header>)/);
  const topbar = topbarMatch ? topbarMatch[1] : '';

  const footerMatch = html.match(/(<footer>[\s\S]*?<\/footer>)/);
  const footer = footerMatch ? footerMatch[1] : '<footer><p>Auto-generated</p></footer>';

  return { projectName, headHtml, topbar, footer };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove any existing class="active" from the topbar and set it on the link
 * whose href matches `pageName`. Idempotent - the regex removes all prior
 * active classes before setting the new one.
 */
export function setActiveLink(topbarHtml, pageName) {
  const withoutActive = topbarHtml.replace(/\s+class="active"/g, '');
  const re = new RegExp(`href="${escapeRegExp(pageName)}"`);
  return withoutActive.replace(re, `href="${pageName}" class="active"`);
}

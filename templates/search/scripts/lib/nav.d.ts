// Types for the shared nav.mjs module. Hand-maintained alongside the JS.
// Keep in sync: changes here must also update the runtime validation in
// nav.mjs (parseNavConfig's isNavItem).

/**
 * A leaf nav item or a dropdown parent. Children are restricted to leaves
 * (no grandchildren) because the renderer is single-level - parseNavConfig
 * rejects nested grandchildren so the failure is loud at deploy time
 * rather than silently rendering href="undefined".
 */
export interface NavItem {
  label: string;
  /** Leaf links have `href`; dropdown parents have `children`. */
  href?: string;
  children?: NavLeaf[];
}

export interface NavLeaf {
  label: string;
  href: string;
}

export interface NavConfig {
  items: NavItem[];
  /** Pages that intentionally don't appear in the topbar (e.g. 404.html). */
  navSkip?: string[];
  /**
   * Raw JSON text as served. Always set by parseNavConfig so adapters can
   * round-trip byte-identical content; not a meaningful field when a
   * NavConfig is constructed in-memory (use NavProposal for that shape).
   */
  raw: string;
}

export function parseNavConfig(raw: string): NavConfig | null;
export function renderNav(items: NavItem[], activeFile: string): string;
export function injectNav(html: string, navHtml: string): string;
export function lintNav(pages: string[], config: NavConfig): string[];
export function collectHrefs(items: NavItem[]): string[];

/**
 * Filenames that lintNav always treats as if they were in navSkip,
 * regardless of the project's nav.json. Hardcoded universal conventions
 * (404 page, auto-generated sitemap) - prevents one fresh-install repo
 * from blocking the deploy by forgetting to declare them.
 */
export const IMPLICIT_NAV_SKIP: ReadonlySet<string>;

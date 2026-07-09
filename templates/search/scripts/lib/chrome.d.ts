// Types for chrome.mjs - shared by sitemap + changelog generators.

export interface SiteChrome {
  projectName: string;
  headHtml: string;
  topbar: string;
  footer: string;
}

export function extractSiteChrome(docsDir: string): SiteChrome;
export function setActiveLink(topbarHtml: string, pageName: string): string;

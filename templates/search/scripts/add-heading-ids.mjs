#!/usr/bin/env node
// Adds slugified `id` attributes to <h1>-<h6> tags that don't have one.
// Run before `pagefind` so sub-results link to in-page anchors.
//
// Usage: node scripts/add-heading-ids.mjs <files...>
//        node scripts/add-heading-ids.mjs *.html

import { readFileSync, writeFileSync } from 'node:fs';

const slugify = (raw) =>
  raw
    .replace(/<[^>]+>/g, ' ')           // strip inline tags
    .replace(/&[a-z]+;/gi, ' ')         // strip entities
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: add-heading-ids.mjs <files...>');
  process.exit(1);
}

let totalAdded = 0;
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const seen = new Set();
  let added = 0;
  const after = before.replace(
    /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/g,
    (match, tag, attrs, inner) => {
      if (/\sid\s*=/.test(attrs)) {
        // capture existing IDs so we don't collide
        const m = attrs.match(/\sid\s*=\s*["']([^"']+)["']/);
        if (m) seen.add(m[1]);
        return match;
      }
      const base = slugify(inner);
      if (!base) return match;
      let id = base;
      let n = 2;
      while (seen.has(id)) id = `${base}-${n++}`;
      seen.add(id);
      added++;
      return `<${tag}${attrs} id="${id}">${inner}</${tag}>`;
    }
  );
  if (added > 0) {
    writeFileSync(file, after);
    console.log(`${file}: +${added} heading id(s)`);
    totalAdded += added;
  }
}
console.log(`done — added ${totalAdded} heading id(s)`);

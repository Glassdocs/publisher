# Glassdocs Publisher

The **public** reusable GitHub Actions workflow that publishes a Glassdocs
knowledge base to Cloudflare Pages, secure-by-default (Cloudflare Access enforced,
fail-closed, preview deploys disabled, verify-or-rollback).

It must be public so KB repos in **any** org can call it — a private reusable
workflow can't be used across organizations.

## Use it

In a KB repo's `.github/workflows/deploy.yml`:

```yaml
jobs:
  deploy:
    if: vars.CF_PAGES_PROJECT != ''
    uses: Glassdocs/publisher/.github/workflows/deploy-pages.yml@v1
    with:
      project-name: ${{ vars.CF_PAGES_PROJECT }}
      email-domain: ${{ vars.EMAIL_DOMAIN }}
      client-domain: ${{ vars.CLIENT_DOMAIN }}
      client-emails: ${{ vars.CLIENT_EMAILS }}
    secrets: inherit
```

Pin by tag (`@v1`) — the workflow runs across every consumer repo, so it is a
release-gated artifact.

## What's here

- `.github/workflows/deploy-pages.yml` — the reusable publisher
- `.github/actions/sync-access-policies/` — Cloudflare Access policy reconciler
- `templates/`, `docs/styles.css`, `brand/assets/` — shared build scripts + brand
  assets the workflow fetches at deploy time

Source of truth is the (private) `Glassdocs/glassdocs` monorepo; this repo is the
public, tag-pinned distribution of the publisher.

> Contains no secrets — consumer repos pass Cloudflare credentials via
> `secrets: inherit`.

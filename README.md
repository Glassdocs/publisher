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

### Public KBs (explicit opt-in)

For world-readable documentation (e.g. a product's public docs), pass
`public: true`. No Cloudflare Access app is created — and one already gating
the domain is removed, since public is the declared intent — and the
post-deploy check inverts to "the site must serve content (HTTP 200)".
The default is `false`: a KB never becomes public by omission.

```yaml
    with:
      project-name: ${{ vars.CF_PAGES_PROJECT }}
      public: true
```

## What's here

- `.github/workflows/deploy-pages.yml` — the reusable publisher
- `.github/actions/sync-access-policies/` — Cloudflare Access policy reconciler
- `templates/` — the security-headers file (`_headers`) and the compliance-lint /
  meta-injection scripts the workflow fetches at deploy time

Source of truth is the (private) `Glassdocs/glassdocs` monorepo; this repo is the
public, tag-pinned distribution of the publisher.

> Contains no secrets — consumer repos pass Cloudflare credentials via
> `secrets: inherit`.

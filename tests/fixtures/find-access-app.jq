# VERBATIM COPY of the Access-app matcher used twice in
# .github/workflows/deploy-pages.yml (the private-mode resolver and the
# public-mode gate remover).
#
# It is a copy, not an extraction the workflow references, on purpose: the
# workflow pulls platform files with a sparse checkout pinned to `ref: v1`, so a
# newly added script file is absent from every consumer running the released tag
# until that tag moves. `jq -f <missing file>` would hard-fail the Access
# resolution step — breaking deploys in exactly the component this suite exists
# to stabilise, for no behavioural gain.
#
# The copy is kept honest by the drift guard in find-access-app.test.mjs, which
# fails if this expression and the workflow's ever diverge.
#
# Input: a Cloudflare "list Access apps" response. Arg: $d, the domain.
(.result // [])[] | select(((.self_hosted_domains // []) | index($d)) or ((.destinations // []) | map(.uri) | index($d)) or (.domain == $d)) | .id

# VERBATIM COPY of the preview-wildcard detector in deploy-pages.yml (the check
# that decides whether an EXISTING Access app needs *.<domain> back-filled).
# See find-access-app.jq for why this is a copy; the drift guard keeps it true.
#
# Input: a single Access app object. Arg: $w, the wildcard domain "*.<domain>".
if (((.self_hosted_domains // []) | index($w)) or ((.destinations // []) | map(.uri) | index($w))) then "yes" else "" end

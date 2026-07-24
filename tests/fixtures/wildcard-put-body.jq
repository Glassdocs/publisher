# VERBATIM COPY of the PUT body builder that back-fills *.<domain> onto an
# existing Access app in deploy-pages.yml. See find-access-app.jq for why this
# is a copy; the drift guard keeps it true.
#
# Input: a single Access app object. Arg: $w, the wildcard domain "*.<domain>".
{name, domain, type, session_duration, self_hosted_domains: ((.self_hosted_domains // [.domain]) + [$w])} | with_entries(select(.value != null))

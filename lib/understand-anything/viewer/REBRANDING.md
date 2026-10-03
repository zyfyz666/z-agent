# Project Map display branding

This directory contains the packaged upstream viewer, without its dashboard
source or build script. Z changes only the six `common.appName` display labels,
the HTML document title, and the two favicon assets. Project names loaded from
the graph keep their original values.

After replacing `dist` with a new upstream package, run from the app root:

```sh
node lib/understand-anything/viewer/rebrand.mjs
node lib/understand-anything/viewer/rebrand.mjs --check
```

The operation is idempotent. It locates the main module through `dist/index.html`
and validates each locale using its adjacent keyboard-shortcut label. An unknown
build shape fails before writing any files; review the new display components
and update those exact matches instead of replacing product strings globally.

Upstream package names, API identifiers, comments, author information and
third-party notices remain unchanged. `../THIRD_PARTY_NOTICES.md` retains the
upstream attribution.

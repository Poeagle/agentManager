# draw.io static viewer

Unmodified local viewer from https://github.com/jgraph/drawio, commit
`744cb5420fdf126efd7a09b1d7082ca3e12c0841`:
`src/main/webapp/js/viewer-static.min.js`. The upstream Apache-2.0 license is
included as `LICENSE`; embedded third-party notices remain in the source.

Loaded lazily as raw text and executed only inside a sandboxed opaque-origin
iframe. Document XML never goes to diagrams.net. Its CSP denies network access;
external images, fonts, links, dynamically fetched stencils and math resources
are intentionally unavailable. Standard bundled shapes, compressed/uncompressed
diagrams and multiple pages use the upstream viewer.

Official self-hosting instructions:
https://www.drawio.com/docs/integrations/atlassian/confluence/customise/configure-javascript-viewer-drawio-confluence-server/

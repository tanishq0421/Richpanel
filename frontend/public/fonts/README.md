# Brand fonts

The UI uses Richpanel's own typefaces, taken from richpanel.com's computed
styles: **General Sans** for the interface and **Nohemi** for display headings.
Both are free from [Fontshare](https://www.fontshare.com).

They are **not committed** — font binaries do not belong in git, and the
licences are better satisfied by downloading them directly.

Drop these two files here:

    GeneralSans-Variable.woff2
    Nohemi-Variable.woff2

from:

- https://www.fontshare.com/fonts/general-sans
- https://www.fontshare.com/fonts/nohemi

Until they are present the UI falls back to the system sans stack declared in
`src/styles/index.css`. It stays fully usable — the layout, spacing and colour
are unaffected — but it will not look like Richpanel.

Self-hosted rather than loaded from the Fontshare CDN on purpose: it keeps the
Content-Security-Policy at `font-src 'self'` and removes a render-blocking
third-party request from the critical path.

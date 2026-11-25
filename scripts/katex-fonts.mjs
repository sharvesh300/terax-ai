// KaTeX's stylesheet lists every font as woff2, woff and ttf. WebKit (every
// Terax webview) uses woff2, so the other two are dead weight in the app
// bundle (about 800 KiB). This keeps only the woff2 source of each face.

const FALLBACK_SOURCE =
  /,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g;

/** KaTeX CSS with only woff2 font sources. */
export function keepWoff2Only(css) {
  return css.replace(FALLBACK_SOURCE, "");
}

const KATEX_CSS = /[\\/]katex[\\/]dist[\\/]katex(?:\.min)?\.css(?:\?|$)/;

/** Vite plugin applying `keepWoff2Only` before Vite resolves the CSS urls. */
export function katexWoff2Only() {
  return {
    name: "terax:katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!KATEX_CSS.test(id)) return null;
      return { code: keepWoff2Only(code), map: null };
    },
  };
}

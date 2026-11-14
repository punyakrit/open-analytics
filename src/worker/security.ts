/**
 * The page policy. Scripts run only from this site's own files: no inline scripts, no eval, nothing from
 * other hosts. Styles and fonts may also come from Google Fonts; images from site favicons (Google's favicon
 * service), map tiles and Google profile pictures; the map's own worker runs from a blob. Nothing may frame
 * the dashboard, and forms only post back here. public/_headers repeats this for files served without the
 * Worker; keep the two the same.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://www.google.com https://*.gstatic.com https://*.googleusercontent.com https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

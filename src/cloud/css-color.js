"use strict";

// Sanitize a user-supplied CSS color before it is stored and later echoed into
// inline `style="color:..."` / `background-color:...` declarations served to
// other members. Anything that is not an obviously-safe color literal is
// dropped to "" so it can never break out of the attribute or smuggle in
// `url(...)` / extra declarations. Web and desktop renderers stay the source of
// truth for escaping; this is the defense-in-depth layer at the write boundary.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\)$/i;
const NAMED = /^[a-z]{1,32}$/i; // CSS named colors + keywords (transparent, currentColor)

function sanitizeCssColor(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 64) return "";
  if (HEX.test(raw) || FUNCTIONAL.test(raw) || NAMED.test(raw)) return raw;
  return "";
}

module.exports = { sanitizeCssColor };

"use strict";

const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { domainToASCII } = require("node:url");

const MAX_WEB_RESPONSE_BYTES = 2 * 1024 * 1024;
const WEB_REQUEST_TIMEOUT_MS = 12_000;
const MAX_WEB_REDIRECTS = 3;

function cleanText(value = "") {
  return String(value || "").trim();
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function ipv4Number(address = "") {
  const parts = String(address || "").split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4Number(address);
  const network = ipv4Number(base);
  if (value == null || network == null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

function ipv6Number(address = "") {
  let value = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!value) return null;
  if (value.includes(".")) {
    const colon = value.lastIndexOf(":");
    if (colon < 0) return null;
    const ipv4 = ipv4Number(value.slice(colon + 1));
    if (ipv4 == null) return null;
    value = `${value.slice(0, colon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = halves.length === 2 ? [...left, ...Array(fill).fill("0"), ...right] : left;
  if ((halves.length === 2 && fill < 1) || parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((out, part) => (out << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function ipv6InCidr(value, base, prefix) {
  const address = typeof value === "bigint" ? value : ipv6Number(value);
  const network = ipv6Number(base);
  if (address == null || network == null) return false;
  const shift = 128n - BigInt(prefix);
  return (address >> shift) === (network >> shift);
}

function isPublicIpAddress(address = "") {
  const family = net.isIP(String(address || "").replace(/^\[|\]$/g, ""));
  if (family === 4) {
    return !BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (value == null || (value >> 125n) !== 1n) return false;
  return ![
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["2002::", 16]
  ].some(([base, prefix]) => ipv6InCidr(value, base, prefix));
}

function normalizedPublicHostname(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!raw) return "";
  if (net.isIP(raw)) return raw;
  return domainToASCII(raw).toLowerCase();
}

function isBlockedHostname(value = "") {
  const hostname = normalizedPublicHostname(value);
  if (!hostname) return true;
  if (net.isIP(hostname)) return !isPublicIpAddress(hostname);
  if (!hostname.includes(".")) return true;
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".home")
    || hostname.endsWith(".arpa");
}

function parsePublicHttpUrl(value = "") {
  const raw = String(value || "").trim();
  if (raw.length > 4096) throw new Error("url is too long");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("url must be a valid http:// or https:// URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("url must be a valid http:// or https:// URL");
  }
  if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed");
  if (isBlockedHostname(parsed.hostname)) throw new Error("refusing to fetch local or private network URL");
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  if (parsed.port && parsed.port !== defaultPort) throw new Error("only standard HTTP and HTTPS ports are allowed");
  parsed.hash = "";
  return parsed;
}

async function resolvePublicTarget(value, options = {}) {
  const parsed = value instanceof URL ? value : parsePublicHttpUrl(value);
  const hostname = normalizedPublicHostname(parsed.hostname);
  if (net.isIP(hostname)) return { parsed, addresses: [{ address: hostname, family: net.isIP(hostname) }] };
  const lookupHost = options.lookupHost || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
  const timeoutMs = clampNumber(options.timeoutMs, 100, 30_000, WEB_REQUEST_TIMEOUT_MS);
  let timeout = null;
  const resolved = await Promise.race([
    Promise.resolve().then(() => lookupHost(hostname)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("web DNS lookup timed out")), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeout));
  const addresses = (Array.isArray(resolved) ? resolved : [resolved])
    .map((item) => typeof item === "string" ? { address: item, family: net.isIP(item) } : item)
    .filter((item) => item?.address && item?.family);
  if (!addresses.length) throw new Error("public hostname did not resolve");
  if (addresses.some((item) => !isPublicIpAddress(item.address))) {
    throw new Error("refusing hostname that resolves to a local or private network address");
  }
  return { parsed, addresses };
}

function decodeResponseBody(buffer, contentType = "") {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] || "utf-8";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function requestResolvedTarget(target, options = {}) {
  const { parsed, addresses } = target;
  const transport = parsed.protocol === "https:" ? https : http;
  const maxBytes = clampNumber(options.maxBytes, 1024, MAX_WEB_RESPONSE_BYTES, MAX_WEB_RESPONSE_BYTES);
  const timeoutMs = clampNumber(options.timeoutMs, 100, 30_000, WEB_REQUEST_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const req = transport.request({
      protocol: parsed.protocol,
      hostname: normalizedPublicHostname(parsed.hostname),
      port: parsed.port || undefined,
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      method: "GET",
      agent: false,
      headers: {
        "User-Agent": "MiaCloudBot/0.1 (+https://mia.gifgif.cn)",
        Accept: "text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.2",
        "Accept-Encoding": "identity",
        ...(options.headers || {})
      },
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) return callback(null, addresses);
        const address = addresses[0];
        return callback(null, address.address, address.family);
      }
    }, (res) => {
      const status = Number(res.statusCode || 0);
      const location = cleanText(res.headers.location || "");
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.resume();
        finish(null, { status, location, headers: res.headers, text: "" });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error("web response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (status < 200 || status >= 300) {
          finish(new Error(`web request returned HTTP ${status}`));
          return;
        }
        const contentType = String(res.headers["content-type"] || "");
        const body = Buffer.concat(chunks);
        finish(null, {
          status,
          headers: res.headers,
          contentType,
          text: decodeResponseBody(body, contentType)
        });
      });
      res.on("error", (error) => finish(error));
    });
    deadline = setTimeout(() => req.destroy(new Error("web request timed out")), timeoutMs);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("web request timed out")));
    req.on("error", (error) => finish(error));
    req.end();
  });
}

async function requestPublicText(value, options = {}) {
  let current = parsePublicHttpUrl(value);
  const redirects = clampNumber(options.redirects, 0, 5, MAX_WEB_REDIRECTS);
  for (let count = 0; count <= redirects; count += 1) {
    const target = await resolvePublicTarget(current, options);
    const response = await requestResolvedTarget(target, options);
    if (!response.location) return { ...response, url: current.toString() };
    if (count >= redirects) throw new Error("too many web redirects");
    current = parsePublicHttpUrl(new URL(response.location, current).toString());
  }
  throw new Error("too many web redirects");
}

const HTML_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  lt: "<",
  nbsp: " ",
  quot: "\""
});

function decodeHtmlEntities(value = "") {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return HTML_ENTITIES[lower] ?? match;
  });
}

function stripHtml(value = "") {
  return decodeHtmlEntities(String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|section|article|main|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedSearchResultUrl(value = "") {
  try {
    const parsed = new URL(decodeHtmlEntities(value));
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || isBlockedHostname(parsed.hostname)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function duckDuckGoResultUrl(value = "") {
  try {
    const parsed = new URL(decodeHtmlEntities(value), "https://duckduckgo.com");
    return normalizedSearchResultUrl(parsed.searchParams.get("uddg") || parsed.toString());
  } catch {
    return "";
  }
}

function parseDuckDuckGoResults(source = "", limit = 5) {
  const results = [];
  const blockPattern = /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|$)/gi;
  const anchorPattern = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetPattern = /<(?:a|div)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i;
  for (const match of String(source || "").matchAll(blockPattern)) {
    if (results.length >= limit) break;
    const anchor = anchorPattern.exec(match[0]);
    if (!anchor) continue;
    const url = duckDuckGoResultUrl(anchor[1]);
    const title = stripHtml(anchor[2]);
    if (!url || !title || results.some((item) => item.url === url)) continue;
    const snippet = snippetPattern.exec(match[0]);
    results.push({
      title: title.slice(0, 300),
      url,
      snippet: (snippet ? stripHtml(snippet[1]) : "").slice(0, 1200),
      position: results.length + 1
    });
  }
  return results;
}

function xmlTagText(block = "", tag = "") {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return match ? stripHtml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
}

function parseBingRssResults(source = "", limit = 5) {
  const results = [];
  for (const match of String(source || "").matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    if (results.length >= limit) break;
    const title = xmlTagText(match[1], "title");
    const url = normalizedSearchResultUrl(xmlTagText(match[1], "link"));
    if (!title || !url || results.some((item) => item.url === url)) continue;
    results.push({
      title: title.slice(0, 300),
      url,
      snippet: xmlTagText(match[1], "description").slice(0, 1200),
      position: results.length + 1
    });
  }
  return results;
}

async function searchPublicWeb(args = {}, options = {}) {
  const query = cleanText(args.query || args.q || "");
  if (!query) throw new Error("query is required");
  if (query.length > 500) throw new Error("query must be at most 500 characters");
  const limit = clampNumber(args.limit, 1, 10, 5);
  const requestText = options.requestPublicText || requestPublicText;
  const providers = [
    {
      name: "bing-rss",
      url: `https://www.bing.com/search?${new URLSearchParams({ format: "rss", q: query })}`,
      parse: parseBingRssResults
    },
    {
      name: "duckduckgo",
      url: `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`,
      parse: parseDuckDuckGoResults
    }
  ];
  const warnings = [];
  for (const provider of providers) {
    try {
      const response = await requestText(provider.url, options);
      const results = provider.parse(response.text, limit);
      if (results.length) {
        return {
          query,
          success: true,
          source: provider.name,
          results,
          ...(warnings.length ? { warnings } : {})
        };
      }
      warnings.push(`${provider.name} returned no results`);
    } catch (error) {
      warnings.push(`${provider.name} failed: ${error.message}`);
    }
  }
  return { query, success: false, source: "none", results: [], warnings, error: warnings[0] || "web search failed" };
}

async function fetchPublicPage(args = {}, options = {}) {
  const url = cleanText(args.url || "");
  if (!url) throw new Error("url is required");
  const maxChars = clampNumber(args.maxChars, 1000, 30_000, 12_000);
  const requestText = options.requestPublicText || requestPublicText;
  const response = await requestText(url, options);
  const contentType = String(response.contentType || response.headers?.["content-type"] || "");
  if (contentType && !/(?:text\/|json|xml|xhtml|rss|atom)/i.test(contentType)) {
    throw new Error(`unsupported web content type: ${contentType}`);
  }
  const source = String(response.text || "");
  const looksHtml = /html|xhtml/i.test(contentType) || /<(?:html|body|article|main)\b/i.test(source);
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(source);
  const text = looksHtml ? stripHtml(source) : source.trim();
  return {
    url: cleanText(response.url || url),
    title: titleMatch ? stripHtml(titleMatch[1]) : "",
    contentType,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars
  };
}

module.exports = {
  fetchPublicPage,
  isPublicIpAddress,
  parseBingRssResults,
  parseDuckDuckGoResults,
  requestPublicText,
  resolvePublicTarget,
  searchPublicWeb
};

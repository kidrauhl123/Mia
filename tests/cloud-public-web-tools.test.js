const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchPublicPage,
  isPublicIpAddress,
  parseBingRssResults,
  parseDuckDuckGoResults,
  resolvePublicTarget,
  searchPublicWeb
} = require("../src/cloud-agent/public-web-tools.js");

const DUCKDUCKGO_HTML = `
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1&amp;rut=abc">Example &amp; Docs</a>
    </h2>
    <a class="result__snippet">Live <b>documentation</b> result.</a>
  </div>
`;

const BING_RSS = `
  <?xml version="1.0"?>
  <rss><channel>
    <item>
      <title>Current release &amp; notes</title>
      <link>https://example.org/releases/latest</link>
      <description>Published today.</description>
    </item>
    <item>
      <title>Private result must be dropped</title>
      <link>http://127.0.0.1/admin</link>
      <description>Internal.</description>
    </item>
  </channel></rss>
`;

test("cloud public web parsers return clean public results", () => {
  assert.deepEqual(parseDuckDuckGoResults(DUCKDUCKGO_HTML, 5), [{
    title: "Example & Docs",
    url: "https://example.com/docs?a=1",
    snippet: "Live documentation result.",
    position: 1
  }]);
  assert.deepEqual(parseBingRssResults(BING_RSS, 5), [{
    title: "Current release & notes",
    url: "https://example.org/releases/latest",
    snippet: "Published today.",
    position: 1
  }]);
});

test("cloud public web search falls back to a second provider", async () => {
  const requested = [];
  const result = await searchPublicWeb({ query: "Mia latest release", limit: 3 }, {
    async requestPublicText(url) {
      requested.push(url);
      if (url.includes("bing.com")) throw new Error("rate limited");
      return { text: DUCKDUCKGO_HTML };
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.source, "duckduckgo");
  assert.equal(result.results.length, 1);
  assert.match(result.warnings[0], /bing-rss failed: rate limited/);
  assert.equal(requested.length, 2);
  assert.match(requested[0], /q=Mia\+latest\+release/);

  await assert.rejects(
    searchPublicWeb({ query: "x".repeat(501) }, { requestPublicText: async () => ({ text: "" }) }),
    /at most 500 characters/
  );
});

test("cloud public web fetch extracts readable text and rejects binary content", async () => {
  const page = await fetchPublicPage({ url: "https://example.com/article", maxChars: 2000 }, {
    async requestPublicText() {
      return {
        url: "https://example.com/article",
        contentType: "text/html; charset=utf-8",
        text: "<html><head><title>Today &amp; Tomorrow</title><style>.x{}</style></head><body><main><h1>Headline</h1><p>Useful text.</p><script>secret()</script></main></body></html>"
      };
    }
  });

  assert.equal(page.title, "Today & Tomorrow");
  assert.match(page.text, /Headline/);
  assert.match(page.text, /Useful text/);
  assert.doesNotMatch(page.text, /secret|\.x/);

  await assert.rejects(
    fetchPublicPage({ url: "https://example.com/image" }, {
      async requestPublicText() {
        return { contentType: "image/png", text: "not really a png" };
      }
    }),
    /unsupported web content type/
  );
});

test("cloud public web networking blocks local, private, and DNS-rebound targets", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicIpAddress(address), true, address);
  }

  await assert.rejects(resolvePublicTarget("http://127.0.0.1/"), /local or private/);
  await assert.rejects(resolvePublicTarget("http://169.254.169.254/latest/meta-data"), /local or private/);
  await assert.rejects(resolvePublicTarget("https://user:secret@example.com/"), /credentials are not allowed/);
  await assert.rejects(resolvePublicTarget("https://example.com:8443/"), /standard HTTP and HTTPS ports/);
  await assert.rejects(resolvePublicTarget("https://public.example/", {
    async lookupHost() {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 }
      ];
    }
  }), /resolves to a local or private/);
  await assert.rejects(resolvePublicTarget("https://timeout.example/", {
    timeoutMs: 50,
    lookupHost() {
      return new Promise(() => {});
    }
  }), /DNS lookup timed out/);

  const target = await resolvePublicTarget("https://public.example/path", {
    async lookupHost() {
      return [{ address: "93.184.216.34", family: 4 }];
    }
  });
  assert.equal(target.parsed.hostname, "public.example");
  assert.deepEqual(target.addresses, [{ address: "93.184.216.34", family: 4 }]);
});

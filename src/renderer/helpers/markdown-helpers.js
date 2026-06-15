// Markdown / syntax-highlight / icon helpers
// Extracted from app.js. Pure text-in/text-out renderers used by chat,
// skill preview, message context menu, and any other inline content path.
//
// Self-contained: no state.* / els.* / mia.* dependencies. Module
// registers on window.miaMarkdown at script-load time; no init needed.
(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Icon path data adapted from ByteDance IconPark (Apache-2.0).
  const ICON_PARK = {
    addPic: '<path d="M38 21V40C38 41.1046 37.1046 42 36 42H8C6.89543 42 6 41.1046 6 40V12C6 10.8954 6.89543 10 8 10H26.3636" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.0005 31.0308L18.0005 23L21.0005 26L24.5005 20.5L32.0005 31.0308H12.0005Z" fill="none" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M34.0005 10H42.0005" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M37.9946 5.79541V13.7954" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/>',
    bellOff: '<path d="M12 21C12 14.3726 17.3726 9 24 9C30.6274 9 36 14.3726 36 21C36 28 38 34 40 36H8C10 34 12 28 12 21Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 36C19 38.7614 21.2386 41 24 41C26.7614 41 29 38.7614 29 36" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8L40 40" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
    copy: '<path d="M13 12.4316V7.8125C13 6.2592 14.2592 5 15.8125 5H40.1875C41.7408 5 43 6.2592 43 7.8125V32.1875C43 33.7408 41.7408 35 40.1875 35H35.5163" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32.1875 13H7.8125C6.2592 13 5 14.2592 5 15.8125V40.1875C5 41.7408 6.2592 43 7.8125 43H32.1875C33.7408 43 35 41.7408 35 40.1875V15.8125C35 14.2592 33.7408 13 32.1875 13Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
    delete: '<path d="M9 10V44H39V10H9Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M20 20V33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 20V33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 10H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 10L19.289 4H28.7771L32 10H16Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
    documentFolder: '<path d="M32 6H22V42H32V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M42 6H32V42H42V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M10 6L18 7L14.5 42L6 41L10 6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M37 18V15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M27 18V15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
    edit: '<path d="M7 42H43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 26.7199V34H18.3172L39 13.3081L31.6951 6L11 26.7199Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
    folderOpen: '<path d="M4 9V41L9 21H39.5V15C39.5 13.8954 38.6046 13 37.5 13H24L19 7H6C4.89543 7 4 7.89543 4 9Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 41L44 21H8.8125L4 41H40Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
    history: '<path d="M5.81836 6.72729V14H13.0911" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 24C4 35.0457 12.9543 44 24 44V44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C16.598 4 10.1351 8.02111 6.67677 13.9981" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.005 12L24.0038 24.0088L32.4832 32.4882" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
    message: '<path d="M4 6H44V36H29L24 41L19 36H4V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M23 21H25.0025" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M33.001 21H34.9999" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M13.001 21H14.9999" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
    pin: '<path d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
    preview: '<path d="M24 36C35.0457 36 44 24 44 24C44 24 35.0457 12 24 12C12.9543 12 4 24 4 24C4 24 12.9543 36 24 36Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
    quote: '<path fill-rule="evenodd" clip-rule="evenodd" d="M18.8533 9.11587C11.3227 13.9521 7.13913 19.5811 6.30256 26.0028C5.00021 35.9999 13.9404 40.8932 18.4703 36.4966C23.0002 32.1 20.2848 26.5195 17.0047 24.9941C13.7246 23.4686 11.7187 23.9999 12.0686 21.9614C12.4185 19.923 17.0851 14.2712 21.1849 11.6391C21.4569 11.4078 21.5604 10.959 21.2985 10.6185C21.1262 10.3946 20.7883 9.95545 20.2848 9.30102C19.8445 8.72875 19.4227 8.75017 18.8533 9.11587Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M38.6789 9.11587C31.1484 13.9521 26.9648 19.5811 26.1282 26.0028C24.8259 35.9999 33.7661 40.8932 38.296 36.4966C42.8259 32.1 40.1105 26.5195 36.8304 24.9941C33.5503 23.4686 31.5443 23.9999 31.8943 21.9614C32.2442 19.923 36.9108 14.2712 41.0106 11.6391C41.2826 11.4078 41.3861 10.959 41.1241 10.6185C40.9519 10.3946 40.614 9.95545 40.1105 9.30102C39.6702 8.72875 39.2484 8.75017 38.6789 9.11587Z" fill="currentColor"/>',
    tag: '<path d="M5 8H27L43 24L27 40H5V8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 24H16.01" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
    translate: '<path d="M28.2857 37H39.7143M42 42L39.7143 37M26 42L28.2857 37M28.2857 37L34 24L39.7143 37H28.2857Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 6L17 9" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 16C10 16 11.7895 22.2609 16.2632 25.7391C20.7368 29.2174 28 32 28 32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 11C24 11 22.2105 19.2174 17.7368 23.7826C13.2632 28.3478 6 32 6 32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
    "add-friend": '<path d="M24 11C24 14.866 20.866 18 17 18C13.134 18 10 14.866 10 11C10 7.13401 13.134 4 17 4C20.866 4 24 7.13401 24 11Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M5 40C5 33.3726 10.3726 28 17 28C19.5 28 21.82 28.764 23.74 30.07" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 35H42" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M36 29V41" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
  };

  function iconParkIcon(name, className = "menu-item-icon") {
    const body = ICON_PARK[name];
    if (!body) return "";
    return `<span class="${className}" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" focusable="false">${body}</svg></span>`;
  }

  // IconPark name → animated Lottie spec, for menu icons that have an animated
  // equivalent. Others stay static. The animated icon mounts on menu open
  // (caller runs miaLottieIcons.init(menuEl)) and plays on item hover; the static
  // IconPark svg below is the no-Lottie fallback. useanimations icons rest at
  // frame 0; Lordicon icons (in/hover markers) rest on their formed frame and
  // play only the hover segment, so they carry rest/play.
  // All Lordicon system-regular (one cohesive set). Each has in (0-60) + hover
  // (70-130) markers → rest on the formed frame, play the hover segment. The
  // bell's segments are offset (in 0-90, hover 100-190).
  const ANIMATED_MENU_ICON = {
    copy: { name: "copy", rest: 60, play: "70,130" },
    edit: { name: "edit", rest: 60, play: "70,130" },
    delete: { name: "trash", rest: 60, play: "70,130" },
    quote: { name: "reply", rest: 60, play: "70,130" },
    bellOff: { name: "bell", rest: 90, play: "100,190" },
    message: { name: "chat", rest: 60, play: "70,130" },
    pin: { name: "pin", rest: 60, play: "70,130" },
    tag: { name: "label", rest: 60, play: "70,130" },
    translate: { name: "translate" }, // formed at frame 0, no markers → boomerang
  };

  function menuItemIcon(name) {
    const spec = ANIMATED_MENU_ICON[name];
    if (!spec) return iconParkIcon(name);
    const body = ICON_PARK[name] || "";
    const rest = spec.rest != null ? ` data-lottie-rest="${spec.rest}"` : "";
    const play = spec.play ? ` data-lottie-play="${spec.play}"` : "";
    return `<span class="menu-item-icon" data-lottie="${spec.name}" data-lottie-trigger="hover"${rest}${play} aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" focusable="false">${body}</svg></span>`;
  }

  function menuItemHtml({ icon, label, attrs = "", className = "" }) {
    return `<button class="${className}" type="button" ${attrs}>${menuItemIcon(icon)}<span>${escapeHtml(label)}</span></button>`;
  }

  function renderInlineMarkdown(value) {
    const codes = [];
    let protectedText = String(value || "").replace(/`([^`\n]+)`/g, (_match, code) => {
      const index = codes.push(code) - 1;
      return `@@MIA_INLINE_CODE_${index}@@`;
    });
    const links = [];
    protectedText = protectedText.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, text, url) => {
      const index = links.push({ text, url }) - 1;
      return `@@MIA_LINK_${index}@@`;
    });
    let html = escapeHtml(protectedText);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\n/g, "<br>");
    for (let index = 0; index < codes.length; index++) {
      html = html.replace(
        `@@MIA_INLINE_CODE_${index}@@`,
        `<code class="inline-code" tabindex="0" title="点击复制">${escapeHtml(codes[index])}</code>`
      );
    }
    for (let index = 0; index < links.length; index++) {
      const { text, url } = links[index];
      html = html.replace(
        `@@MIA_LINK_${index}@@`,
        `<a class="message-link" data-external-link="${escapeHtml(url)}" role="link" tabindex="0" title="${escapeHtml(url)}">${escapeHtml(text)}</a>`
      );
    }
    return html;
  }

  function previewMarkdownSource(value) {
    const lines = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const parts = [];
    let fence = null;
    for (const line of lines) {
      const fenceMatch = line.match(/^```([A-Za-z0-9_+.-]*)\s*$/);
      if (fence) {
        if (fenceMatch) {
          const code = fence.join(" ").replace(/\s+/g, " ").trim();
          if (code) parts.push("`" + code + "`");
          fence = null;
        } else if (line.trim()) {
          fence.push(line.trim());
        }
        continue;
      }
      if (fenceMatch) {
        fence = [];
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
      const unordered = trimmed.match(/^[-*]\s+(.+)$/);
      const ordered = trimmed.match(/^(\d+[.)])\s+(.+)$/);
      const quote = trimmed.match(/^>\s?(.+)$/);
      if (heading) parts.push(heading[1]);
      else if (unordered) parts.push("• " + unordered[1]);
      else if (ordered) parts.push(ordered[1] + " " + ordered[2]);
      else if (quote) parts.push(quote[1]);
      else parts.push(trimmed);
    }
    if (fence && fence.length) parts.push("`" + fence.join(" ").replace(/\s+/g, " ").trim() + "`");
    return parts.join(" ");
  }

  function renderPreviewMarkdown(value) {
    const codes = [];
    let protectedText = previewMarkdownSource(value).replace(/`([^`\n]+)`/g, (_match, code) => {
      const index = codes.push(code) - 1;
      return `MIAPREVIEWCODE${index}TOKEN`;
    });
    const links = [];
    protectedText = protectedText.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, text, url) => {
      const index = links.push({ text, url }) - 1;
      return `MIAPREVIEWLINK${index}TOKEN`;
    });
    let html = escapeHtml(protectedText);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?，。！？])/g, "$1<em>$2</em>");
    for (let index = 0; index < codes.length; index++) {
      html = html.replace(
        `MIAPREVIEWCODE${index}TOKEN`,
        `<code class="sidebar-inline-code">${escapeHtml(codes[index])}</code>`
      );
    }
    for (let index = 0; index < links.length; index++) {
      const { text, url } = links[index];
      html = html.replace(
        `MIAPREVIEWLINK${index}TOKEN`,
        `<span class="sidebar-preview-link" title="${escapeHtml(url)}">${escapeHtml(text)}</span>`
      );
    }
    return html;
  }

  function codeLanguageId(language = "") {
    const raw = String(language || "").trim().toLowerCase();
    const aliases = {
      javascript: "js",
      typescript: "ts",
      shell: "bash",
      sh: "bash",
      zsh: "bash",
      yml: "yaml"
    };
    return aliases[raw] || raw || "text";
  }

  function codeLanguageLabel(language = "") {
    const id = codeLanguageId(language);
    const labels = {
      js: "JavaScript",
      jsx: "JSX",
      ts: "TypeScript",
      tsx: "TSX",
      json: "JSON",
      bash: "Shell",
      yaml: "YAML",
      text: "Text"
    };
    return labels[id] || id.toUpperCase();
  }

  function highlightPlainSegment(segment, language) {
    const id = codeLanguageId(language);
    const keywords = id === "bash"
      ? new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "set"])
      : new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "class", "extends", "new", "try", "catch", "finally", "throw", "async", "await", "import", "from", "export", "default", "typeof", "instanceof", "in", "of", "this", "super"]);
    const source = String(segment || "");
    const tokenPattern = /--?[A-Za-z0-9][\w-]*|\b[A-Za-z_$][\w$-]*\b|\b\d+(?:\.\d+)?\b|[=!<>|&+\-*/%?:.,;()[\]{}]+/g;
    let cursor = 0;
    let html = "";
    for (const match of source.matchAll(tokenPattern)) {
      const token = match[0];
      const offset = match.index ?? 0;
      if (offset > cursor) html += escapeHtml(source.slice(cursor, offset));
      const escaped = escapeHtml(token);
      if (/^\d/.test(token)) html += `<span class="syntax-number">${escaped}</span>`;
      else if (id === "bash" && token.startsWith("-")) html += `<span class="syntax-parameter">${escaped}</span>`;
      else if (/^[=!<>|&+\-*/%?:]+$/.test(token)) html += `<span class="syntax-operator">${escaped}</span>`;
      else if (/^[.,;()[\]{}]+$/.test(token)) html += `<span class="syntax-punctuation">${escaped}</span>`;
      else if (keywords.has(token)) html += `<span class="syntax-keyword">${escaped}</span>`;
      else if (["true", "false", "null", "undefined"].includes(token)) html += `<span class="syntax-literal">${escaped}</span>`;
      else {
        const before = source.slice(0, offset).replace(/\s+$/g, "");
        const after = source.slice(offset + token.length).replace(/^\s+/g, "");
        if (before.endsWith(".")) html += `<span class="syntax-property">${escaped}</span>`;
        else if (after.startsWith("(")) html += `<span class="syntax-function">${escaped}</span>`;
        else if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) html += `<span class="syntax-class">${escaped}</span>`;
        else html += `<span class="syntax-variable">${escaped}</span>`;
      }
      cursor = offset + token.length;
    }
    if (cursor < source.length) html += escapeHtml(source.slice(cursor));
    return html;
  }

  function highlightCode(code, language = "") {
    const id = codeLanguageId(language);
    if (!["js", "jsx", "ts", "tsx", "json", "bash"].includes(id)) return escapeHtml(code);
    const source = String(code || "");
    const parts = [];
    const pattern = id === "json"
      ? /("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\]:,])/gi
      : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(\$[A-Za-z_][\w]*|\$\{[^}]+\})/g;
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) parts.push(highlightPlainSegment(source.slice(cursor, index), id));
      const token = match[0];
      if (id === "json") {
        const after = source.slice(index + token.length).replace(/^\s+/g, "");
        if (match[1] && after.startsWith(":")) parts.push(`<span class="syntax-property">${escapeHtml(token)}</span>`);
        else if (match[1]) parts.push(`<span class="syntax-string">${escapeHtml(token)}</span>`);
        else if (match[2]) parts.push(`<span class="syntax-number">${escapeHtml(token)}</span>`);
        else if (match[3]) parts.push(`<span class="syntax-literal">${escapeHtml(token)}</span>`);
        else parts.push(`<span class="syntax-punctuation">${escapeHtml(token)}</span>`);
      } else if (match[1]) {
        parts.push(`<span class="syntax-string">${escapeHtml(token)}</span>`);
      } else if (match[2]) {
        parts.push(`<span class="syntax-comment">${escapeHtml(token)}</span>`);
      } else if (match[3]) {
        parts.push(`<span class="syntax-variable">${escapeHtml(token)}</span>`);
      }
      cursor = index + token.length;
    }
    if (cursor < source.length) parts.push(highlightPlainSegment(source.slice(cursor), id));
    return parts.join("");
  }

  function renderCodeBlock(code, language = "") {
    const lang = codeLanguageId(language).replace(/[^A-Za-z0-9_+.-]/g, "").slice(0, 24);
    const label = codeLanguageLabel(lang);
    return `
      <figure class="message-code-block" data-language="${escapeHtml(lang)}">
        <figcaption>
          <button type="button" class="message-code-copy" data-copy-code aria-label="复制 ${escapeHtml(label)} 代码" title="复制 ${escapeHtml(label)} 代码">${escapeHtml(label)}</button>
        </figcaption>
        <pre><code class="syntax-code language-${escapeHtml(lang)}">${highlightCode(String(code || "").replace(/\n$/, ""), lang)}</code></pre>
      </figure>
    `;
  }

  function splitTableCells(line) {
    let text = String(line || "").trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|")) text = text.slice(0, -1);
    return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
  }

  function isTableDelimiterRow(line) {
    if (!line || line.indexOf("-") === -1) return false;
    const cells = splitTableCells(line);
    return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
  }

  function tableCellAlignment(spec) {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  }

  function renderTable(headerLine, delimiterLine, rowLines) {
    const aligns = splitTableCells(delimiterLine).map(tableCellAlignment);
    const headers = splitTableCells(headerLine);
    const styleFor = (index) => (aligns[index] ? ` style="text-align:${aligns[index]}"` : "");
    const head = headers
      .map((cell, index) => `<th${styleFor(index)}>${renderInlineMarkdown(cell)}</th>`)
      .join("");
    const body = rowLines
      .map((rowLine) => {
        const cells = splitTableCells(rowLine);
        const tds = headers
          .map((_, index) => `<td${styleFor(index)}>${renderInlineMarkdown(cells[index] || "")}</td>`)
          .join("");
        return `<tr>${tds}</tr>`;
      })
      .join("");
    return `<div class="message-table-wrap"><table class="message-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderMarkdown(value) {
    const lines = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const html = [];
    let paragraph = [];
    let list = null;
    let fence = null;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
      list = null;
    };
    const flushTextBlocks = () => {
      flushParagraph();
      flushList();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = line.match(/^```([A-Za-z0-9_+.-]*)\s*$/);
      if (fence) {
        if (fenceMatch) {
          html.push(renderCodeBlock(fence.lines.join("\n"), fence.language));
          fence = null;
        } else {
          fence.lines.push(line);
        }
        continue;
      }
      if (fenceMatch) {
        flushTextBlocks();
        fence = { language: fenceMatch[1] || "", lines: [] };
        continue;
      }
      if (!line.trim()) {
        flushTextBlocks();
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) {
        flushTextBlocks();
        html.push('<hr class="message-divider">');
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushTextBlocks();
        const level = heading[1].length;
        html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      if (unordered) {
        flushParagraph();
        if (!list || list.type !== "ul") {
          flushList();
          list = { type: "ul", items: [] };
        }
        list.items.push(unordered[1]);
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        flushParagraph();
        if (!list || list.type !== "ol") {
          flushList();
          list = { type: "ol", items: [] };
        }
        list.items.push(ordered[1]);
        continue;
      }
      if (line.indexOf("|") !== -1 && isTableDelimiterRow(lines[i + 1])) {
        // GFM requires the delimiter row to have the same column count as the
        // header. The mismatch check also rejects most accidental paragraph + rule
        // combinations (e.g. one-cell `---` after a sentence containing a `|`).
        const headerCells = splitTableCells(line);
        const delimiterCells = splitTableCells(lines[i + 1]);
        if (headerCells.length === delimiterCells.length && headerCells.length > 0) {
          flushTextBlocks();
          const rowLines = [];
          let j = i + 2;
          while (j < lines.length && lines[j].trim() && lines[j].indexOf("|") !== -1) {
            rowLines.push(lines[j]);
            j++;
          }
          html.push(renderTable(line, lines[i + 1], rowLines));
          i = j - 1;
          continue;
        }
      }
      paragraph.push(line);
    }
    flushTextBlocks();
    if (fence) html.push(renderCodeBlock(fence.lines.join("\n"), fence.language));
    return html.join("");
  }

  window.miaMarkdown = {
    escapeHtml,
    ICON_PARK,
    iconParkIcon,
    menuItemHtml,
    renderInlineMarkdown,
    renderPreviewMarkdown,
    codeLanguageId,
    codeLanguageLabel,
    highlightPlainSegment,
    highlightCode,
    renderCodeBlock,
    renderMarkdown,
  };
})();

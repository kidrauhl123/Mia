// Skill data helpers
// Pure functions extracted from app.js (formerly lines 2681-2738). No state
// or DOM dependencies; safe to call before any init. Exposed under
// window.aimashiSkillHelpers for direct use from app.js and from any future
// skill-related module.
(function () {
  "use strict";

  // escapeHtml is injected via initSkillHelpers() — used only by the markdown
  // renderers below. The 7 pure data helpers don't need it.
  let escapeHtml = (value) => String(value || "");

  function initSkillHelpers(deps) {
    if (deps && typeof deps.escapeHtml === "function") {
      escapeHtml = deps.escapeHtml;
    }
  }

  function skillTone(skill = {}) {
    const text = `${skill.category || ""} ${(skill.tags || []).join(" ")} ${skill.name || ""}`.toLowerCase();
    if (/creative|image|video|art|design|media|p5|ascii|music/.test(text)) return "creative";
    if (/software|github|devops|mcp|agent|plugin|install|author|code/.test(text)) return "build";
    if (/apple|productivity|email|note|calendar|maps|home/.test(text)) return "ops";
    return "docs";
  }

  function skillInitials(name = "") {
    const parts = String(name || "?").split(/[-_\s/]+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : String(name || "?").slice(0, 2)).toUpperCase();
  }

  function pluginSourceLabel(source = "") {
    const labels = {
      "aimashi-official": "Aimashi 官方",
      aimashi: "Aimashi Runtime",
      codex: "Codex",
      claude: "Claude Code"
    };
    return labels[source] || "Skill";
  }

  function skillAuthorLabel(skill = {}) {
    if (skill.source === "aimashi-official") return "Aimashi 官方";
    if (skill.source === "aimashi") return "Aimashi Runtime";
    if (skill.source === "codex") return "Codex";
    if (skill.source === "claude") return "Claude Code";
    return skill.sourceLabel || "Local";
  }

  function skillHasUpdate(_skill) {
    return false;
  }

  function skillDisplayName(skill = {}) {
    return skill.name || skill.title || "Skill";
  }

  function skillSummaryZh(skill = {}) {
    const exact = {
      imagegen: "生成或编辑图片素材，适合做视觉参考、头像、纹理、插画和界面 mockup。",
      "openai-docs": "查询 OpenAI 官方文档，适合模型选择、API 用法和迁移升级问题。",
      "plugin-creator": "创建 Codex 插件目录和配置，适合把工具能力打包成可复用插件。",
      "skill-creator": "编写或改造 SKILL.md，适合把稳定工作流沉淀成 Codex 可调用的技能。",
      "skill-installer": "从本地清单或 GitHub 安装 Codex Skill，适合扩展本机技能库。",
      "pet-generator": "把角色、品牌或参考图做成桌宠 spritesheet，并输出预览和打包文件。",
      "hatch-pet": "把角色图做成 Codex 宠物 spritesheet，并输出预览和打包文件。"
    };
    if (exact[skill.name]) return exact[skill.name];
    const text = `${skill.category || ""} ${(skill.tags || []).join(" ")} ${skill.name || ""}`.toLowerCase();
    if (/creative|image|video|art|design|media|p5|ascii|music/.test(text)) return "创作与多媒体相关能力，适合图像、视频、音频、设计或可视化任务。";
    if (/software|github|devops|mcp|agent|plugin|install|author|code|test/.test(text)) return "工程开发相关能力，适合代码实现、调试、测试、插件、仓库或自动化工作流。";
    if (/research|paper|search|web|data|analysis|market/.test(text)) return "资料研究相关能力，适合检索、归纳、分析和结构化知识整理。";
    if (/apple|productivity|email|note|calendar|maps|home/.test(text)) return "个人效率和系统集成相关能力，适合连接本机应用、日程、笔记或自动化操作。";
    if (/system|docs|doc|write|markdown/.test(text)) return "文档和通用工作流能力，适合阅读说明、整理内容或辅助写作。";
    return skill.description || "这个 Skill 提供一组可复用的本地指令，点击可预览原始 SKILL.md 内容。";
  }

  function stripSkillFrontmatter(value = "") {
    const text = String(value || "");
    if (!text.startsWith("---")) return text;
    const lines = text.split(/\r?\n/);
    const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
    return end > 0 ? lines.slice(end + 1).join("\n").trim() : text;
  }

  function renderSkillInlineMarkdown(value = "") {
    return escapeHtml(value)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderSkillMarkdownSource(value = "") {
    const lines = stripSkillFrontmatter(value).split(/\r?\n/);
    const html = [];
    let paragraph = [];
    let list = [];
    let quote = [];
    let code = null;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${renderSkillInlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) return;
      html.push(`<ul>${list.map((item) => `<li>${renderSkillInlineMarkdown(item)}</li>`).join("")}</ul>`);
      list = [];
    };
    const flushQuote = () => {
      if (!quote.length) return;
      html.push(`<blockquote>${quote.map((item) => `<p>${renderSkillInlineMarkdown(item)}</p>`).join("")}</blockquote>`);
      quote = [];
    };
    const flushFlow = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    for (const line of lines) {
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        if (code) {
          const lang = code.lang || "text";
          html.push(`
            <div class="code-card">
              <div class="code-caption"><span>${escapeHtml(lang)}</span></div>
              <pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>
            </div>
          `);
          code = null;
        } else {
          flushFlow();
          code = { lang: fence[1].trim(), lines: [] };
        }
        continue;
      }
      if (code) {
        code.lines.push(line);
        continue;
      }
      if (!line.trim()) {
        flushFlow();
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        flushFlow();
        html.push(`<h${heading[1].length}>${renderSkillInlineMarkdown(heading[2].trim())}</h${heading[1].length}>`);
        continue;
      }
      const listItem = line.match(/^\s*[-*]\s+(.+)$/);
      if (listItem) {
        flushParagraph();
        flushQuote();
        list.push(listItem[1].trim());
        continue;
      }
      const quoteLine = line.match(/^>\s*(.*)$/);
      if (quoteLine) {
        flushParagraph();
        flushList();
        quote.push(quoteLine[1].trim());
        continue;
      }
      paragraph.push(line.trim());
    }
    flushFlow();
    return html.join("");
  }

  window.aimashiSkillHelpers = {
    initSkillHelpers,
    skillTone,
    skillInitials,
    pluginSourceLabel,
    skillAuthorLabel,
    skillHasUpdate,
    skillDisplayName,
    skillSummaryZh,
    stripSkillFrontmatter,
    renderSkillInlineMarkdown,
    renderSkillMarkdownSource,
  };
})();

// Skill data helpers
// Pure functions extracted from app.js (formerly lines 2681-2738). No state
// or DOM dependencies; safe to call before any init. Exposed under
// window.miaSkillHelpers for direct use from app.js and from any future
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
    const text = `${skillDisplayCategory(skill)} ${(skill.tags || []).join(" ")} ${skillDisplayName(skill)} ${skill.name || ""}`.toLowerCase();
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
      "mia-official": "Mia 官方",
      mia: "Mia Runtime",
      codex: "Codex",
      claude: "Claude Code"
    };
    return labels[source] || "Skill";
  }

  function skillAuthorLabel(skill = {}) {
    if (skill.source === "mia-official") return "Mia 官方";
    if (skill.source === "mia") return "Mia Runtime";
    if (skill.source === "codex") return "Codex";
    if (skill.source === "claude") return "Claude Code";
    return skill.sourceLabel || "Local";
  }

  function skillHasUpdate(_skill) {
    return false;
  }

  const officialNamesZh = {
    "academic-writing": "学术写作",
    "data-analysis": "数据分析",
    "deep-research": "深度研究",
    docx: "Word 文档",
    "email-drafting": "邮件起草",
    flashcards: "Anki 记忆卡",
    "frontend-design": "前端界面设计",
    "latex-document": "LaTeX 排版",
    "literature-review": "文献综述",
    "mcp-builder": "MCP 服务搭建",
    "meeting-notes": "会议纪要",
    "document-editor": "文档编辑",
    pdf: "PDF 文档处理",
    "paper-notes": "论文阅读笔记",
    pptx: "PPT 幻灯片",
    "resume-polish": "简历优化",
    "revision-notes": "复习笔记",
    translation: "翻译润色",
    "web-artifacts-builder": "网页交互件构建",
    "webapp-testing": "Web 应用测试",
    xlsx: "Excel 表格",
    "mia-scheduler": "定时任务",
    "paper-research": "文献研究",
    "lab-report": "实验报告",
    "study-review": "复习规划",
    "resume-interview": "简历面试",
    "problem-explainer": "讲题排错",
    "spreadsheet-organizer": "表格整理",
    "pet-generator": "桌宠生成",
    "skill-creator": "技能创作"
  };

  const officialCategoriesZh = {
    "academic-writing": "写作效率",
    "data-analysis": "研究资料",
    "deep-research": "研究资料",
    docx: "文档处理",
    "email-drafting": "写作效率",
    flashcards: "学习",
    "frontend-design": "开发工程",
    "latex-document": "学习",
    "literature-review": "研究资料",
    "mcp-builder": "开发工程",
    "meeting-notes": "写作效率",
    pdf: "文档处理",
    "paper-notes": "研究资料",
    pptx: "文档处理",
    "resume-polish": "写作效率",
    "revision-notes": "学习",
    "skill-creator": "开发工程",
    translation: "写作效率",
    "web-artifacts-builder": "开发工程",
    "webapp-testing": "开发工程",
    xlsx: "文档处理"
  };

  function skillDisplayName(skill = {}) {
    if (skill.marketNameZh) return skill.marketNameZh;
    if (skill.name_zh) return skill.name_zh;
    if (skill.source === "mia-official" && officialNamesZh[skill.name]) return officialNamesZh[skill.name];
    return skill.name || skill.title || "Skill";
  }

  function skillDisplayCategory(skill = {}) {
    if (skill.source === "mia-official" && officialCategoriesZh[skill.name]) return officialCategoriesZh[skill.name];
    return skill.marketCategoryZh || skill.category_zh || skill.category || "uncategorized";
  }

  function skillSummaryZh(skill = {}) {
    if (skill.marketSummaryZh) return skill.marketSummaryZh;
    if (skill.summary_zh) return skill.summary_zh;
    const exact = {
      imagegen: "生成或编辑图片素材，适合做视觉参考、头像、纹理、插画和界面 mockup。",
      "openai-docs": "查询 OpenAI 官方文档，适合模型选择、API 用法和迁移升级问题。",
      "plugin-creator": "创建 Codex 插件目录和配置，适合把工具能力打包成可复用插件。",
      "skill-creator": "编写或改造 SKILL.md，适合把稳定工作流沉淀成 Codex 可调用的技能。",
      "skill-installer": "从本地清单或 GitHub 安装 Codex Skill，适合扩展本机技能库。",
      "pet-generator": "把角色、品牌或参考图做成桌宠 spritesheet，并输出预览和打包文件。",
      "hatch-pet": "把角色图做成 Codex 宠物 spritesheet，并输出预览和打包文件。",
      "academic-writing": "辅助学术论文的写作、审阅和润色，覆盖结构搭建、论证打磨、表达规范。适合课程论文、毕业论文、投稿稿件。",
      "data-analysis": "分析 Excel / CSV 数据，自动统计、找出规律、生成可视化图表和分析报告。适合处理问卷、实验数据、运营报表。",
      "deep-research": "围绕一个题目从多个角度展开检索与综合，产出结构化的分析和详尽的研究报告。适合做选题调研、行业分析、决策前的资料梳理。",
      docx: "创建和编辑 Word 文档：排版正文、插入表格、加批注与修订。适合写报告、论文初稿、正式公文。",
      "email-drafting": "根据要点快速起草得体的邮件，把握分寸和措辞。适合写请假、求职、联系导师、对外沟通。",
      flashcards: "依据记忆科学，把学习材料拆成一卡一概念的原子记忆卡，支持数学公式，可导入 Anki。适合背单词、记知识点、备考。",
      "frontend-design": "产出有设计感、不千篇一律的前端界面，讲究排版、配色和细节质感。适合做落地页、组件、网页应用的视觉实现。",
      "latex-document": "用 LaTeX 排出专业的论文、作业和讲义，内置大量模板与脚本，公式、图表、参考文献都处理得当。适合理工科作业和正式排版。",
      "literature-review": "按检索策略找文献、评估来源质量、做主题式综合，并理清引用关系。适合写课程论文、开题报告、研究综述。",
      "mcp-builder": "从零搭建一个 MCP（模型上下文协议）服务，把外部工具和数据接进 AI。适合给智能体扩展自定义能力。",
      "meeting-notes": "把会议记录或转写整理成清晰的纪要，自动抽出决定、待办和负责人、未决问题。适合例会、小组讨论、访谈整理。",
      pdf: "读取并提取 PDF 里的文字和表格，填写表单，按页合并、拆分或重排，也能从零生成新的 PDF。处理合同、报告、扫描件这类文档很顺手。",
      "paper-notes": "从 arXiv、bioRxiv 抓取指定方向的最新论文，逐篇生成中英文结构化摘要：问题、方法、结论、可借鉴点。适合追踪领域进展和文献积累。",
      pptx: "把要点整理成结构清晰的 PowerPoint 幻灯片，自动排版、配图、统一风格。适合课堂展示、答辩、工作汇报。",
      "resume-polish": "对着目标岗位打磨简历：突出成果、量化经历、调整结构和措辞，做 ATS 友好的针对性优化。适合实习、秋招、申研。",
      "revision-notes": "把课本、讲义或长资料浓缩成条理清晰的复习笔记，抓重点、列框架。适合期末突击和知识点回顾。",
      translation: "把英文、日文的文章和资料译成地道流畅的中文，保留专业术语和代码不走样。适合读外文文献、技术文档、资料速读。",
      "web-artifacts-builder": "用 HTML/React 搭建可交互的网页小工具、可视化和原型，一步到位出可运行的成品。适合做演示页、数据看板、互动小应用。",
      "webapp-testing": "为网页应用编写并运行端到端测试，模拟真实点击操作、验证页面行为、定位回归问题。适合上线前自动化验收。",
      xlsx: "读写 Excel 表格，套公式、做透视和图表、批量整理数据。适合算账、统计、把杂乱数据整理成规整表。"
    };
    if (exact[skill.name]) return exact[skill.name];
    const text = `${skillDisplayCategory(skill)} ${(skill.tags || []).join(" ")} ${skill.name || ""}`.toLowerCase();
    if (/creative|image|video|art|design|media|p5|ascii|music/.test(text)) return "创作与多媒体相关能力，适合图像、视频、音频、设计或可视化任务。";
    if (/software|github|devops|mcp|agent|plugin|install|author|code|test/.test(text)) return "工程开发相关能力，适合代码实现、调试、测试、插件、仓库或自动化工作流。";
    if (/research|paper|search|web|data|analysis|market/.test(text)) return "资料研究相关能力，适合检索、归纳、分析和结构化知识整理。";
    if (/apple|productivity|email|note|calendar|maps|home/.test(text)) return "个人效率和系统集成相关能力，适合连接本机应用、日程、笔记或自动化操作。";
    if (/system|docs|doc|write|markdown/.test(text)) return "文档和通用工作流能力，适合阅读说明、整理内容或辅助写作。";
    return skill.description || "这个技能提供一组可复用的本地能力，适合把稳定工作流直接用于当前对话。";
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

  window.miaSkillHelpers = {
    initSkillHelpers,
    skillTone,
    skillInitials,
    pluginSourceLabel,
    skillAuthorLabel,
    skillHasUpdate,
    skillDisplayName,
    skillDisplayCategory,
    skillSummaryZh,
    stripSkillFrontmatter,
    renderSkillInlineMarkdown,
    renderSkillMarkdownSource,
  };
})();

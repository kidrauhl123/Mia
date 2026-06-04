// 发现 AI 同事 —— 预设 fellow 商店（renderer 模块）
// 顶部分类胶囊 + 卡片网格 + 详情覆盖层。点「加到我的聊天」走 saveFellow 写进
// 本地 manifest（和「创建智能体」表单同一条路），加完跳进会话。
//
// PRESETS 目前是随包内置的样例数据；正式版应改为从 official-library / 云端拉取
// （见 resources/official-library/library.json）。emoji 头像为占位，后续可换 Lottie。
(function () {
  "use strict";

  let state, els, mia, escapeHtml, openFellowConversation, render;

  // 样例预设：每个 = 人设包装 + 一段 personaText。技能组合（capabilities）等
  // 有意义的标签体系定了再挂；这里先不填，避免占位标签误导。
  const PRESETS = [
    {
      key: "paper-buddy", cat: "论文", emoji: "📄", c1: "#eef0ff", c2: "#5e5ce6",
      name: "论文搭子", tagline: "文献综述 / 开题 / 引用",
      line: "拖一个装满 PDF 的文件夹进来，30 秒出一张文献综述对比表。",
      desc: "专治写论文最磨人的环节：把一堆文献读完、对比、整理成表。你只管把 PDF 丢进来，它来读。",
      demo: "你：<b>把这个文件夹里 18 篇文献做成综述对比表</b><br>论文搭子：已读完 → 按「作者 / 方法 / 结论 / 局限」生成了一张表 ✅",
      persona: "你是「论文搭子」，帮大学生处理文献相关的活：批量读 PDF、做文献综述对比表、整理引用格式、中英互译。语气务实、简洁，先确认用户给的文件再动手。"
    },
    {
      key: "lab-data", cat: "实验", emoji: "📊", c1: "#e9f9ef", c2: "#1a9d5a",
      name: "实验数据助手", tagline: "画图 / 统计 / 报告",
      line: "丢一个数据表，自动画图、跑统计，再写成实验报告段落。",
      desc: "理工科写 lab report 的苦力都给它。从原始 csv 到能贴进报告的图和结论，一步到位。",
      demo: "你：<b>用这份 data.csv 画个趋势图，跑下相关性</b><br>实验数据助手：图已生成，r = 0.81（强相关），结论段落见下 ✅",
      persona: "你是「实验数据助手」，帮大学生处理实验数据：读数据文件、画图、跑基础统计、把结果写成实验报告段落。动手前先确认数据列的含义。"
    },
    {
      key: "exam-buddy", cat: "复习", emoji: "📚", c1: "#fff3e6", c2: "#d9730a",
      name: "复习搭子", tagline: "提纲 / 自测题",
      line: "把一学期的 PPT、讲义丢进来，出复习提纲 + 自测题。",
      desc: "期末救命。把课件全塞给它，回你一份带例题的复习提纲，还能随时考你两道。",
      demo: "你：<b>这门课 12 个 PPT，帮我整一份复习提纲</b><br>复习搭子：提纲分 5 大块，每块附 2 道自测题 ✅",
      persona: "你是「复习搭子」，帮大学生备考：读 PPT / 讲义，整理出结构清晰的复习提纲，并出自测题。提纲要分块、抓重点，自测题给答案与解析。"
    },
    {
      key: "career-coach", cat: "求职", emoji: "💼", c1: "#eaf1ff", c2: "#2563eb",
      name: "简历面试官", tagline: "改简历 / 模拟面试",
      line: "简历 + JD 丢进来，改一版，还能陪你模拟面试。",
      desc: "网申季搭子。按目标岗位改简历，再扮演面试官跟你过一遍高频问题。",
      demo: "你：<b>照这个产品实习 JD 改我的简历</b><br>简历面试官：已对齐 JD 关键词，改了 6 处，要不要现在模拟面试？",
      persona: "你是「简历面试官」，帮大学生求职：按目标 JD 优化简历措辞与重点，并能扮演面试官做模拟面试、给反馈。先问清目标岗位再动手。"
    },
    {
      key: "speak-partner", cat: "语言", emoji: "🗣️", c1: "#fdeef5", c2: "#c9417e",
      name: "口语陪练", tagline: "对话 / 纠音 / 场景",
      line: "陪你练口语、纠发音，按真实场景模拟对话。",
      desc: "想张口又没人陪练就找它。点餐、面试、答辩，挑个场景直接开聊，错了当场纠。",
      demo: "你：<b>模拟一场英文组会 presentation 问答</b><br>口语陪练：好，我来当教授，先问你第一个问题 …",
      persona: "你是「口语陪练」，陪大学生练外语口语：按用户选的场景对话，温和地纠正发音与表达，并示范更地道的说法。每轮回复简短，鼓励多开口。"
    },
    {
      key: "qa-helper", cat: "复习", emoji: "💡", c1: "#fff7e0", c2: "#b8860b",
      name: "答疑助手", tagline: "讲题 / 讲代码",
      line: "拍一道题、贴一段代码，讲到你懂为止。",
      desc: "卡住的题别死磕。给它题目或报错代码，它一步步拆给你看，而不是直接甩答案。",
      demo: "你：<b>这段代码为什么报 NoneType 错？</b><br>答疑助手：第 14 行 find() 没命中返回了 None，往下拆给你看 …",
      persona: "你是「答疑助手」，帮大学生弄懂题目和代码：一步步拆解思路与原因，而不是直接给最终答案。讲完反问一句确认对方是否听懂。"
    }
  ];

  const CATS = ["全部", "论文", "实验", "复习", "求职", "语言"];
  let activeCat = "全部";
  let adding = false;

  function initFellowStore(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    escapeHtml = deps.escapeHtml || ((s) => String(s == null ? "" : s));
    openFellowConversation = deps.openFellowConversation;
    render = deps.render || (() => {});

    if (els.fellowStoreCap) {
      els.fellowStoreCap.innerHTML = "";
      CATS.forEach((c, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = c;
        if (i === 0) b.classList.add("active");
        b.addEventListener("click", () => {
          activeCat = c;
          els.fellowStoreCap.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          movePill();
          renderGrid();
        });
        els.fellowStoreCap.appendChild(b);
      });
    }

    els.fellowStoreScrim?.addEventListener("click", (event) => {
      if (event.target === els.fellowStoreScrim) closeSheet();
    });

    window.addEventListener("resize", () => {
      if (state.activeView === "fellow-store") movePill();
    });
  }

  function movePill() {
    const cap = els.fellowStoreCap;
    if (!cap) return;
    const a = cap.querySelector("button.active");
    if (!a || typeof a.getBoundingClientRect !== "function") return;
    const hr = cap.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    cap.style.setProperty("--pill-x", `${ar.left - hr.left}px`);
    cap.style.setProperty("--pill-w", `${ar.width}px`);
    cap.style.setProperty("--pill-ready", "1");
  }

  function avatarHtml(f, extraClass) {
    const cls = extraClass ? ` ${extraClass}` : "";
    return `<div class="fellow-store-avatar${cls}" style="background:${f.c1};color:${f.c2}">${f.emoji}</div>`;
  }

  function renderGrid() {
    const grid = els.fellowStoreGrid;
    if (!grid) return;
    const list = PRESETS.filter((f) => activeCat === "全部" || f.cat === activeCat);
    if (!list.length) {
      grid.innerHTML = `<div class="fellow-store-empty">这个分类暂时还没有 AI 同事</div>`;
      return;
    }
    grid.innerHTML = list.map((f, i) => `
      <div class="fellow-store-card" data-key="${escapeHtml(f.key)}" style="animation-delay:${(i * 0.05).toFixed(2)}s">
        <div class="fellow-store-card-head">
          ${avatarHtml(f)}
          <div class="meta">
            <strong>${escapeHtml(f.name)}</strong>
            <div class="tag">${escapeHtml(f.tagline)}</div>
          </div>
        </div>
        <p class="line">${escapeHtml(f.line)}</p>
      </div>`).join("");
    grid.querySelectorAll(".fellow-store-card").forEach((card) => {
      card.addEventListener("click", () => {
        const f = PRESETS.find((x) => x.key === card.dataset.key);
        if (f) openSheet(f);
      });
    });
  }

  function openSheet(f) {
    const sheet = els.fellowStoreSheet;
    const scrim = els.fellowStoreScrim;
    if (!sheet || !scrim) return;
    adding = false;
    sheet.innerHTML = `
      <div class="fellow-store-sheet-head">
        ${avatarHtml(f)}
        <div><h2>${escapeHtml(f.name)}</h2><div class="tag">${escapeHtml(f.tagline)}</div></div>
      </div>
      <p class="desc">${escapeHtml(f.desc)}</p>
      <div class="fellow-store-demo">${f.demo}</div>
      <div class="fellow-store-actions">
        <button type="button" class="fellow-store-btn ghost" data-act="back">返回</button>
        <button type="button" class="fellow-store-btn primary" data-act="add">＋ 加到我的聊天</button>
      </div>`;
    sheet.querySelector('[data-act="back"]').addEventListener("click", closeSheet);
    sheet.querySelector('[data-act="add"]').addEventListener("click", () => addFellow(f));
    scrim.classList.add("open");
  }

  function closeSheet() {
    els.fellowStoreScrim?.classList.remove("open");
  }

  async function addFellow(f) {
    if (adding) return;
    adding = true;
    const btn = els.fellowStoreSheet?.querySelector('[data-act="add"]');
    if (btn) { btn.disabled = true; btn.textContent = "正在添加…"; }
    try {
      const saved = await window.miaFellowCommands.saveFellow({
        state,
        runtimeKind: "desktop-local",
        isCreate: true,
        api: window.mia,
        social: window.miaSocial,
        fellow: {
          name: f.name,
          color: f.c2,
          description: f.line,
          personaText: f.persona,
          agentEngine: "hermes"
        }
      });
      if (saved.runtime) state.runtime = saved.runtime;
      closeSheet();
      const savedKey = saved.key || "";
      if (savedKey && typeof openFellowConversation === "function") {
        state.activeView = "chat";
        await openFellowConversation(savedKey);
      } else {
        render();
      }
    } catch (error) {
      if (btn) { btn.disabled = false; btn.textContent = "＋ 加到我的聊天"; }
      adding = false;
      window.alert(`添加失败：${error?.message || error}`);
      return;
    }
    adding = false;
  }

  // 进入商店视图时调用：渲染网格并对齐胶囊
  function renderFellowStore() {
    renderGrid();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(movePill);
    else movePill();
  }

  window.miaFellowStore = { initFellowStore, renderFellowStore };
})();

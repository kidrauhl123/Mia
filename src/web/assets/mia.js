/* ============================================================
   Mia 宣传页 — 交互与动画
   ============================================================ */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Refined icon-based Bot avatars (no more character art)
  const ICON = {
    coder:    '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>',
    detective:'<circle cx="11" cy="11" r="6.2"/><path d="M20.5 20.5 16 16"/>',
    analyst:  '<path d="M5 20V13"/><path d="M10 20V6"/><path d="M15 20v-9"/><path d="M20 20V9"/>',
    camera:   '<path d="M12 4l1.7 4.8L18.5 10l-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z"/>',
    coffee:   '<path d="M14.5 5.5l4 4"/><path d="M4 20l1-4L16 5a2.12 2.12 0 0 1 3 3L8 19l-4 1z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  };
  const HUE = { coder: 'teal', detective: 'indigo', analyst: 'violet', camera: 'rose', coffee: 'amber', calendar: 'amber' };
  const AV = { coder: 'coder', detective: 'detective', analyst: 'analyst', camera: 'camera', coffee: 'coffee', calendar: 'calendar' };
  const avHTML = (role) =>
    `<div class="mw-av av av--${HUE[role] || 'indigo'}"><svg viewBox="0 0 24 24">${ICON[role] || ICON.coder}</svg></div>`;
  function paintAvatar(node, role) {
    if (!node) return;
    node.className = `mw-av av av--${HUE[role] || 'indigo'}`;
    node.innerHTML = `<svg viewBox="0 0 24 24">${ICON[role] || ICON.coder}</svg>`;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const DOWNLOADS = {
    'mac-apple': {
      href: '/downloads/Mia-0.1.43-Apple-Silicon.dmg',
      download: 'Mia-0.1.43-Apple-Silicon.dmg',
      label: '下载 macOS 版',
      shortLabel: '下载',
      icon: 'apple'
    },
    'mac-intel': {
      href: '/downloads/Mia-0.1.43-Intel.dmg',
      download: 'Mia-0.1.43-Intel.dmg',
      label: '下载 Intel Mac 版',
      shortLabel: 'Intel Mac',
      icon: 'apple'
    },
    windows: {
      href: '/downloads/mia-windows-latest.exe',
      download: 'Mia-0.1.31-Setup.exe',
      label: '下载 Windows 版',
      shortLabel: 'Windows',
      icon: 'windows'
    },
    android: {
      href: '/downloads/mia-android-latest.apk',
      download: 'Mia-Android.apk',
      label: '下载 Android 版',
      shortLabel: 'Android',
      icon: 'android'
    },
    ios: {
      href: '/app/',
      download: '',
      label: '打开 iPhone / iPad 网页版',
      shortLabel: 'iPhone / iPad',
      icon: 'web'
    },
    web: {
      href: '/app/',
      download: '',
      label: '打开网页版',
      shortLabel: '网页版',
      icon: 'web'
    }
  };

  function isAppleMobile(ua, platform, touchPoints) {
    return /iphone|ipad|ipod/.test(ua) || (platform === 'macintel' && touchPoints > 1);
  }

  function initialDownloadKey() {
    const ua = String(navigator.userAgent || '').toLowerCase();
    const platform = String(navigator.platform || '').toLowerCase();
    const touchPoints = Number(navigator.maxTouchPoints || 0);
    if (/android/.test(ua)) return 'android';
    if (isAppleMobile(ua, platform, touchPoints)) return 'ios';
    if (/windows|win32|win64/.test(ua) || platform.startsWith('win')) return 'windows';
    if (/macintosh|mac os x/.test(ua) || platform.startsWith('mac')) return 'mac-apple';
    return 'mac-apple';
  }

  function applyDownload(key) {
    const option = DOWNLOADS[key] || DOWNLOADS['mac-apple'];
    document.querySelectorAll('[data-primary-download]').forEach((button) => {
      button.setAttribute('href', option.href);
      if (option.download) button.setAttribute('download', option.download);
      else button.removeAttribute('download');
      const nestedLabel = button.querySelector('[data-download-label]');
      if (nestedLabel) nestedLabel.textContent = option.label;
      else if (button.hasAttribute('data-download-label')) button.textContent = option.shortLabel || option.label;
    });
    document.querySelectorAll('[data-download-icon]').forEach((icon) => {
      icon.hidden = icon.dataset.downloadIcon !== option.icon;
    });
    document.querySelectorAll('[data-download-option]').forEach((link) => {
      link.setAttribute('aria-current', link.dataset.downloadOption === key ? 'true' : 'false');
    });
  }

  async function refineMacDownloadKey(currentKey) {
    if (!currentKey.startsWith('mac-')) return;
    const hints = navigator.userAgentData;
    if (!hints || typeof hints.getHighEntropyValues !== 'function') return;
    try {
      const values = await hints.getHighEntropyValues(['architecture', 'platform']);
      const platform = String(values.platform || '').toLowerCase();
      const arch = String(values.architecture || '').toLowerCase();
      if (platform && !/mac|macos/.test(platform)) return;
      if (/arm|aarch64/.test(arch)) applyDownload('mac-apple');
      if (/x86|x64|amd64/.test(arch)) applyDownload('mac-intel');
    } catch {
      // Safari and some privacy settings do not expose architecture; keep the
      // default Mac recommendation and leave Intel in the menu.
    }
  }

  function setupDownloadChooser() {
    const key = initialDownloadKey();
    applyDownload(key);
    refineMacDownloadKey(key);

    const trigger = document.querySelector('[data-download-menu-button]');
    const menu = document.querySelector('[data-download-menu]');
    if (!trigger || !menu) return;

    function closeMenu() {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }

    function openMenu() {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const current = menu.querySelector('[aria-current="true"]') || menu.querySelector('a');
      current?.focus({ preventScroll: true });
    }

    trigger.addEventListener('click', () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    });
    document.addEventListener('click', (event) => {
      if (menu.hidden) return;
      if (!menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
  }

  setupDownloadChooser();

  // The Android APK is published under a versioned name (mia-android-<code>.apk)
  // by scripts/publish-mobile-update.js; the same manifest the app reads for
  // in-app updates is the single source of truth for the latest apkUrl. Patch
  // the static fallback link at runtime so the website never points at a stale
  // or missing -latest.apk alias.
  async function patchAndroidDownloadFromManifest() {
    try {
      const res = await fetch('/downloads/mia-mobile-update.json', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const manifest = await res.json();
      const android = manifest && manifest.android;
      const apkUrl = android && typeof android.apkUrl === 'string' ? android.apkUrl : '';
      if (!/^https:\/\/.+\.apk$/i.test(apkUrl)) return;
      const versionName = android.versionName ? String(android.versionName) : '';
      const fileName = versionName ? `Mia-Android-${versionName}.apk` : 'Mia-Android.apk';
      DOWNLOADS.android.href = apkUrl;
      DOWNLOADS.android.download = fileName;
      const menuLink = document.querySelector('[data-download-option="android"]');
      if (menuLink) {
        menuLink.setAttribute('href', apkUrl);
        menuLink.setAttribute('download', fileName);
      }
      // If Android is the currently recommended download, refresh the primary button.
      if (document.querySelector('[data-download-option="android"][aria-current="true"]')) {
        applyDownload('android');
      }
    } catch {
      // Manifest unreachable — keep the static fallback link rather than break the page.
    }
  }

  patchAndroidDownloadFromManifest();

  function setupGsapLargeButton() {
    const gsap = window.gsap;
    const CustomEase = window.CustomEase;
    const roots = document.querySelectorAll('[data-gsap-large-button]');
    if (!gsap || !CustomEase || !roots.length || reduceMotion) return;

    gsap.registerPlugin(CustomEase);

    const largeButtonEases = {
      airtime: CustomEase.create('junguiButtonAirtime', 'M0,0 C0.05,0.356 0.377,0.435 0.5,0.5 0.61,0.558 0.948,0.652 1,1 '),
      rotaaaaate: CustomEase.create('junguiButtonRotate', 'M0,0 C0.148,0.346 0.254,0.444 0.5,0.5 0.751,0.557 0.852,0.646 1,1 '),
    };

    roots.forEach((root) => {
      const getWord = root.querySelector('[data-word="get"]');
      const gsapWord = root.querySelector('[data-word="gsap"]');
      const flairs = root.querySelectorAll('.gsap-large-flair');
      if (!getWord || !gsapWord || !flairs.length) return;

      let playing = false;
      const tl = gsap.timeline({
        defaults: { duration: 1 },
        paused: true,
        onStart: () => {
          playing = true;
        },
        onComplete: () => {
          playing = false;
        },
      });

      gsap.set(flairs, { scale: 0, transformOrigin: '0 0' });

      tl.set(flairs, { scale: 0, x: 0, y: 10, rotateZ: 0, zIndex: 2 })
        .to(getWord, {
          keyframes: [
            { x: -30, ease: 'power4.out' },
            { x: 0, ease: 'power4.in' },
          ],
        })
        .to(
          gsapWord,
          {
            keyframes: [
              { x: 30, ease: 'power4.out' },
              { x: 0, ease: 'power4.in' },
            ],
          },
          '<',
        )
        .to(
          flairs,
          {
            keyframes: [
              { scale: 0, zIndex: 2, duration: 0 },
              { y: () => gsap.utils.random(-80, -120), scale: 1 },
              { zIndex: -1, duration: 0.05 },
              { y: 0, scale: 0.3 },
            ],
            ease: largeButtonEases.airtime,
            stagger: 0.15,
          },
          '<',
        )
        .to(
          flairs,
          {
            x: (index) => index === 1 ? gsap.utils.random(-42, -8) : gsap.utils.random(-50, 100),
            rotateZ: -360,
            ease: largeButtonEases.rotaaaaate,
            stagger: 0.15,
          },
          '<',
        );

      const onEnter = () => {
        if (playing) return;
        tl.invalidate().play(0);
      };

      root.addEventListener('mouseenter', onEnter);
    });
  }

  setupGsapLargeButton();

  /* ---------- nav: shadow + auto-hide (reveal on scroll up, like Marvis) ---------- */
  const nav = document.getElementById('nav');
  let lastY = window.scrollY;
  const onScroll = () => {
    const y = window.scrollY;
    nav.classList.toggle('scrolled', y > 12);
    // hide while scrolling down past the hero; reveal on scroll up; always show near top
    if (y > 560 && y > lastY + 4) {
      nav.classList.add('hidden');
    } else if (y < lastY - 4 || y < 120) {
      nav.classList.remove('hidden');
    }
    lastY = y;
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- reveal on view ---------- */
  const revealIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          revealIO.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  );
  document.querySelectorAll('.reveal').forEach((el) => revealIO.observe(el));

  // Safety fallback: never let content stay hidden if IO is throttled/unavailable.
  // Reveal anything already in viewport immediately, and force-reveal the rest soon after.
  function revealInViewport() {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    document.querySelectorAll('.reveal:not(.in)').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.95 && r.bottom > 0) el.classList.add('in');
    });
  }
  requestAnimationFrame(revealInViewport);
  window.addEventListener('load', revealInViewport);
  window.addEventListener('scroll', revealInViewport, { passive: true });

  /* ---------- helpers to build chat nodes ---------- */
  function bubble({ av, me, html, sender, mini }) {
    const wrap = document.createElement('div');
    wrap.className = 'mw-msg' + (me ? ' me' : '');
    wrap.style.opacity = '0';
    wrap.style.transform = 'translateY(10px)';
    wrap.style.transition = 'opacity .45s cubic-bezier(.16,1,.3,1), transform .45s cubic-bezier(.16,1,.3,1)';
    const avHtml = av ? avHTML(av) : '';
    const senderHtml = sender ? `<div class="demo-sender">${sender}</div>` : '';
    wrap.innerHTML = `${avHtml}<div><div class="mw-bubble${me ? ' me' : ''}${mini ? ' mini' : ''}">${html}</div></div>`;
    if (sender) {
      // put sender label above bubble
      const col = wrap.querySelector('div:last-child');
      col.insertAdjacentHTML('afterbegin', senderHtml);
    }
    return wrap;
  }

  function typingBubble(av) {
    const wrap = document.createElement('div');
    wrap.className = 'mw-msg';
    wrap.dataset.typing = '1';
    wrap.style.opacity = '0';
    wrap.style.transform = 'translateY(10px)';
    wrap.style.transition = 'opacity .35s, transform .35s';
    wrap.innerHTML = `${avHTML(av)}<div><div class="mw-bubble"><span class="mw-typing"><i></i><i></i><i></i></span></div></div>`;
    return wrap;
  }

  function show(node) {
    requestAnimationFrame(() => {
      node.style.opacity = '1';
      node.style.transform = 'none';
    });
  }

  async function streamBubble(node, html, scrollEl) {
    const target = node.querySelector('.mw-bubble');
    if (!target) return;
    target.classList.add('streaming');
    target.innerHTML = '';
    const parts = String(html).match(/<[^>]+>|[^<]/g) || [];
    let next = '';
    for (const part of parts) {
      next += part;
      target.innerHTML = next;
      scrollChat(scrollEl);
      if (part.startsWith('<')) {
        await wait(8);
      } else if (/[，。:：、.!?？]/.test(part)) {
        await wait(90);
      } else {
        await wait(24);
      }
    }
    target.classList.remove('streaming');
  }

  /* ============================================================
     HERO — looping scripted conversation
     ============================================================ */
  const heroBody = document.getElementById('heroBody');
  const heroField = document.getElementById('heroField');
  const heroTopAvatar = document.getElementById('heroTopAvatar');
  const heroTopName = document.getElementById('heroTopName');
  const heroTopMeta = document.getElementById('heroTopMeta');
  const heroRows = Array.from(document.querySelectorAll('[data-hero-conversation]'));
  const heroComposerFoot = document.getElementById('heroComposerFoot');
  const heroModelIcon = document.getElementById('heroModelIcon');
  const heroModelLabel = document.getElementById('heroModelLabel');
  const heroEffortLabel = document.getElementById('heroEffortLabel');
  const heroPermissionLabel = document.getElementById('heroPermissionLabel');
  let activeHeroConversation = 'research';
  let heroPlaybackToken = 0;

  const heroConversations = {
    research: {
      name: '阿研',
      meta: '研究助理 · 独立记忆',
      avatar: AV.detective,
      field: '问阿研，Enter 发送…',
      model: { label: 'Auto', icon: 'assets/mia-logo.png' },
      effort: 'Medium',
      permission: 'Ask',
      script: [
        { type: 'user', html: '阿研，把这 18 页资料整理成明天展示能用的版本。' },
        { type: 'typing', av: AV.detective, ms: 1100 },
        { type: 'bot', av: AV.detective, html: '我先按你的课程展示偏好整理: 3 个论点、4 条可引用句、2 个例子。' },
        {
          type: 'trace',
          av: AV.detective,
          rows: [
            { status: 'ok', cmd: 'memory', arg: '课程展示偏好 / 上次口吻', meta: 'read', body: '偏好: 先给结构，再给可以直接放进 PPT 的句子。' },
            { status: 'ok', cmd: 'read', arg: '18 页课程资料', meta: '0.8s' },
            { status: 'ok', cmd: 'extract', arg: '3 个论点 · 4 条引用 · 2 个例子', meta: '1.2s' },
            { status: 'run', cmd: 'draft', arg: '课程展示 / outline.md', meta: 'pending' },
          ]
        },
        { type: 'typing', av: AV.detective, ms: 950 },
        { type: 'bot', av: AV.detective, html: '草稿结构好了: 背景、问题、方法、结论。每段我都标了适合放进 PPT 的句子。' },
        { type: 'perm' },
        { type: 'user', html: '允许，写入草稿', mini: true },
        { type: 'typing', av: AV.detective, ms: 850 },
        { type: 'bot', av: AV.detective, html: '已写入草稿。下次继续这份展示时，我会沿用这条会话里的背景和口吻。' },
      ]
    },
    writing: {
      name: '阿文',
      meta: '写作助理 · 记住你的语气',
      avatar: AV.coffee,
      field: '问阿文，Enter 发送…',
      model: { label: 'Claude Opus 4.8', icon: 'assets/icons/claude.svg' },
      effort: 'High',
      permission: 'Ask',
      script: [
        { type: 'user', html: '阿文，这段开头太像论文了，帮我改得像口头展示。' },
        { type: 'typing', av: AV.coffee, ms: 850 },
        { type: 'bot', av: AV.coffee, html: '我保留核心观点，把第一句改成更像你会说的话。' },
        { type: 'typing', av: AV.coffee, ms: 850 },
        { type: 'bot', av: AV.coffee, html: '给你三版: 稳一点、轻松一点、直接一点。你上次更喜欢第二种语气。' },
      ]
    },
    career: {
      name: '求职小组',
      meta: '阿研 + 阿文 + 小序 · 协同中',
      avatar: AV.analyst,
      field: '在求职小组里发消息…',
      group: true,
      script: [
        { type: 'user', html: '这段项目经历怎么写才不像流水账?' },
        { type: 'typing', av: AV.analyst, ms: 850 },
        { type: 'bot', av: AV.analyst, sender: '阿研 · 分析', html: '先把结果放前面: 留存提升、转化提升、负责范围。' },
        { type: 'typing', av: AV.coffee, ms: 900 },
        { type: 'bot', av: AV.coffee, sender: '阿文 · 表达', html: '我把它压成两行简历句子，面试版再保留细节。' },
        { type: 'typing', av: AV.analyst, ms: 850 },
        { type: 'bot', av: AV.analyst, sender: '小序 · 计划', html: '还差一项: 补具体数字。要我今晚提醒你查数据吗?' },
      ]
    },
    creative: {
      name: '小映',
      meta: '创意助理 · 封面与标题',
      avatar: AV.camera,
      field: '问小映，Enter 发送…',
      model: { label: 'GPT-5.5', icon: 'assets/icons/codex.svg' },
      effort: 'Medium',
      permission: 'Ask',
      script: [
        { type: 'user', html: '小映，封面别太模板，想要更像个人作品。' },
        { type: 'typing', av: AV.camera, ms: 900 },
        { type: 'bot', av: AV.camera, html: '我收敛成两个方向: 干净截图流、手写批注流。' },
        { type: 'typing', av: AV.camera, ms: 820 },
        { type: 'bot', av: AV.camera, html: '标题建议用动作句，不用抽象口号。比如: “把资料变成能讲的稿”。' },
      ]
    },
    schedule: {
      name: '小序',
      meta: '计划助理 · 日程权限仅本次',
      avatar: AV.calendar,
      field: '问小序，Enter 发送…',
      model: { label: 'Auto', icon: 'assets/mia-logo.png' },
      effort: 'Low',
      permission: 'Ask',
      script: [
        { type: 'user', html: '小序，明晚提醒我练两遍展示开场。' },
        { type: 'typing', av: AV.calendar, ms: 850 },
        { type: 'bot', av: AV.calendar, html: '可以。我会创建一个 22:00 的复习提醒。' },
        { type: 'typing', av: AV.calendar, ms: 760 },
        { type: 'bot', av: AV.calendar, html: '已安排。提醒只关联这条展示会话，不会混到你的求职计划里。' },
      ]
    }
  };

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  function stripHTML(value) {
    return String(value || '').replace(/<[^>]*>/g, '');
  }

  function heroPerm() {
    const node = document.createElement('div');
    node.className = 'mw-perm';
    node.style.opacity = '0';
    node.style.transform = 'translateY(10px)';
    node.style.transition = 'opacity .45s, transform .45s';
    node.innerHTML = `
      <div class="mw-perm-head">
        <span class="pulse"></span>
        <span class="mw-perm-kick">需要你的允许</span>
        <span class="mw-perm-meta">Mia · 文件权限</span>
      </div>
      <div class="mw-perm-cmd">写入文件: 课程展示 / outline.md</div>
      <div class="mw-perm-actions">
        <span class="ghost">拒绝</span>
        <button class="mw-pbtn">仅这次</button>
        <button class="mw-pbtn primary">允许</button>
      </div>`;
    return node;
  }

  function setHeroChrome(id) {
    const conversation = heroConversations[id] || heroConversations.research;
    activeHeroConversation = id;
    paintAvatar(heroTopAvatar, conversation.avatar);
    if (heroTopName) heroTopName.textContent = conversation.name;
    if (heroTopMeta) heroTopMeta.textContent = conversation.meta;
    if (heroField) {
      heroField.textContent = conversation.field || '输入消息，Enter 发送…';
      heroField.style.color = '';
    }
    heroRows.forEach((row) => {
      const on = row.dataset.heroConversation === id;
      row.classList.toggle('on', on);
      row.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    updateHeroComposer(conversation);
  }

  function updateHeroComposer(conversation) {
    if (!heroComposerFoot) return;
    if (conversation.group) {
      heroComposerFoot.hidden = true;
      return;
    }

    const model = conversation.model || heroConversations.research.model;
    heroComposerFoot.hidden = false;
    if (heroModelIcon) {
      if (model?.icon) {
        heroModelIcon.hidden = false;
        heroModelIcon.src = model.icon;
      } else {
        heroModelIcon.hidden = true;
      }
    }
    if (heroModelLabel) heroModelLabel.textContent = model?.label || 'Auto';
    if (heroEffortLabel) heroEffortLabel.textContent = conversation.effort || 'Medium';
    if (heroPermissionLabel) heroPermissionLabel.textContent = conversation.permission || 'Ask';
  }

  function renderHeroMessages(messages) {
    if (!heroBody) return;
    heroBody.innerHTML = '';
    messages.forEach((message) => {
      heroBody.appendChild(show2(bubble(message)));
    });
    scrollChat(heroBody);
  }

  function renderHeroStatic(id) {
    heroPlaybackToken += 1;
    setHeroChrome(id);
    const conversation = heroConversations[id] || heroConversations.research;
    renderHeroMessages(conversation.script.filter((step) => step.type === 'user' || step.type === 'bot').map((step) => ({
      me: step.type === 'user',
      av: step.type === 'bot' ? (step.av || conversation.avatar) : undefined,
      sender: step.sender,
      mini: step.mini,
      html: step.html
    })));
  }

  function heroStillPlaying(token, id) {
    return token === heroPlaybackToken && activeHeroConversation === id;
  }

  function traceRowHTML(row) {
    const status = row.status || 'ok';
    const body = row.body
      ? `<div class="mw-trace-body">${escapeHTML(row.body)}</div>`
      : '';
    return `
      <details class="mw-trace-row trace-anim-enter" data-status="${escapeHTML(status)}"${row.body ? ' open' : ''}>
        <summary>
          <span class="mw-trace-chevron">›</span>
          <span class="mw-trace-glyph">${status === 'run' ? '◇' : '✓'}</span>
          <span class="mw-trace-cmd">${escapeHTML(row.cmd)}</span>
          <span class="mw-trace-arg">${escapeHTML(row.arg)}</span>
          <span class="mw-trace-meta">${escapeHTML(row.meta || '')}</span>
        </summary>
        ${body}
      </details>`;
  }

  function traceBlock(step, conversation) {
    const wrap = document.createElement('div');
    wrap.className = 'mw-msg mw-msg--trace';
    wrap.style.opacity = '0';
    wrap.style.transform = 'translateY(10px)';
    wrap.style.transition = 'opacity .42s cubic-bezier(.16,1,.3,1), transform .42s cubic-bezier(.16,1,.3,1)';
    wrap.innerHTML = `${avHTML(step.av || conversation.avatar)}<div><div class="mw-trace" role="presentation"></div></div>`;
    return wrap;
  }

  async function playTrace(step, conversation, token, id) {
    const node = traceBlock(step, conversation);
    const list = node.querySelector('.mw-trace');
    heroBody.appendChild(node);
    show(node);
    scrollChat(heroBody);
    for (const row of step.rows || []) {
      if (!heroStillPlaying(token, id)) return;
      await wait(row.delay || 240);
      list.insertAdjacentHTML('beforeend', traceRowHTML(row));
      scrollChat(heroBody);
    }
    await wait(step.ms || 520);
  }

  async function playHeroStep(step, conversation, token, id) {
    if (step.type === 'user') {
      if (step.mini) {
        await typeField(step.compose || stripHTML(step.html));
        if (!heroStillPlaying(token, id)) return;
        await wait(250);
        if (heroField) heroField.textContent = conversation.field;
      }
      const n = bubble({ me: true, html: step.html, mini: step.mini });
      heroBody.appendChild(n);
      show(n);
      scrollChat(heroBody);
      await wait(step.wait || 900);
    } else if (step.type === 'typing') {
      const t = typingBubble(step.av || conversation.avatar);
      heroBody.appendChild(t);
      show(t);
      scrollChat(heroBody);
      await wait(step.ms || 1000);
      t.remove();
    } else if (step.type === 'bot') {
      const n = bubble({ av: step.av || conversation.avatar, sender: step.sender, html: '' });
      heroBody.appendChild(n);
      show(n);
      scrollChat(heroBody);
      await streamBubble(n, step.html, heroBody);
      await wait(step.wait || 520);
    } else if (step.type === 'trace') {
      await playTrace(step, conversation, token, id);
    } else if (step.type === 'perm') {
      const p = heroPerm();
      heroBody.appendChild(p);
      show(p);
      scrollChat(heroBody);
      await wait(1400);
      if (!heroStillPlaying(token, id)) return;
      const allow = p.querySelector('.mw-pbtn.primary');
      allow.textContent = '已允许 ✓';
      allow.style.background = 'var(--green)';
      await wait(600);
      p.style.transition = 'opacity .4s, transform .4s, max-height .4s';
      p.style.maxHeight = p.offsetHeight + 'px';
      await wait(20);
      p.style.opacity = '0';
      p.style.transform = 'translateY(-6px)';
      p.style.maxHeight = '0';
      p.style.overflow = 'hidden';
      await wait(420);
      p.remove();
    }
  }

  async function playHeroConversation(id, options = {}) {
    if (!heroBody) return;
    const token = heroPlaybackToken + 1;
    heroPlaybackToken = token;
    const conversation = heroConversations[id] || heroConversations.research;
    setHeroChrome(id);
    if (reduceMotion) {
      renderHeroStatic(id);
      return;
    }
    const loop = Boolean(options.loop);
    while (heroStillPlaying(token, id)) {
      heroBody.innerHTML = '';
      for (const step of conversation.script) {
        if (!heroStillPlaying(token, id)) return;
        await playHeroStep(step, conversation, token, id);
        if (!heroStillPlaying(token, id)) return;
      }
      if (!loop) return;
      await wait(3400);
      if (!heroStillPlaying(token, id)) return;
      // fade out before looping
      heroBody.style.transition = 'opacity .5s';
      heroBody.style.opacity = '0';
      await wait(520);
      heroBody.style.opacity = '1';
    }
  }

  function playHero() {
    return playHeroConversation('research', { loop: true });
  }

  async function typeField(text) {
    if (!heroField) return;
    heroField.style.color = 'var(--ink)';
    for (let i = 1; i <= text.length; i++) {
      heroField.textContent = text.slice(0, i);
      await wait(55);
    }
    await wait(200);
    heroField.style.color = '';
  }

  function scrollChat(el) {
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
  function show2(n) { n.style.opacity = '1'; n.style.transform = 'none'; return n; }

  heroRows.forEach((row) => {
    const id = row.dataset.heroConversation;
    row.addEventListener('click', () => {
      playHeroConversation(id, { loop: id === 'research' });
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      playHeroConversation(id, { loop: id === 'research' });
    });
  });

  /* ============================================================
     GROUP DEMO — cascade when in view (loops)
     ============================================================ */
  const groupBody = document.getElementById('groupBody');
  const groupScript = [
    { me: true, html: '<span class="mention">@阿研</span> 整理文献重点,<span class="mention">@阿文</span> 压一版 5 分钟讲稿' },
    { typing: AV.detective, ms: 1200 },
    { av: AV.detective, sender: '阿研 · 资料', html: '三篇文章的核心观点和可引用句子整理好了。' },
    { typing: AV.analyst, ms: 1100 },
    { av: AV.analyst, sender: '阿析 · 数据', html: '问卷数据我做成两张图，结论会更直观。' },
    { typing: AV.coffee, ms: 1300 },
    { av: AV.coffee, sender: '阿文 · 写作', html: '讲稿已经压到 5 分钟，结尾更有记忆点。' },
  ];

  async function playGroup() {
    if (reduceMotion) {
      groupScript.forEach((s) => {
        if (s.typing) return;
        const n = bubble({ me: s.me, av: s.av, html: s.html, sender: s.sender });
        n.style.opacity = '1'; n.style.transform = 'none';
        groupBody.appendChild(n);
      });
      return;
    }
    while (true) {
      groupBody.innerHTML = '';
      for (const s of groupScript) {
        if (s.typing) {
          const t = typingBubble(s.typing);
          groupBody.appendChild(t);
          show(t);
          groupBody.scrollTop = groupBody.scrollHeight;
          await wait(s.ms || 1000);
          t.remove();
        } else {
          const n = bubble({ me: s.me, av: s.av, html: s.html, sender: s.sender });
          groupBody.appendChild(n);
          show(n);
          groupBody.scrollTop = groupBody.scrollHeight;
          await wait(1500);
        }
      }
      await wait(3000);
      groupBody.style.transition = 'opacity .5s';
      groupBody.style.opacity = '0';
      await wait(520);
      groupBody.style.opacity = '1';
    }
  }

  /* ============================================================
     PERMISSION static demo — clickable + auto pulse
     ============================================================ */
  const permAllow = document.getElementById('permAllow');
  const permBanner = document.getElementById('permBanner');
  const permDemo = document.getElementById('permDemo');
  let permDone = false;

  function approve() {
    if (permDone) return;
    permDone = true;
    permAllow.textContent = '已允许 ✓';
    permAllow.style.background = 'var(--green)';
    permAllow.style.transition = 'background .3s';
    setTimeout(() => {
      permBanner.style.transition = 'opacity .4s, transform .4s';
      permBanner.style.opacity = '0';
      permBanner.style.transform = 'translateY(-6px)';
      setTimeout(() => {
        const ok = bubble({ av: AV.analyst, html: '已创建提醒。明晚 22:00 我会叫你复习展示稿。' });
        permBanner.replaceWith(ok);
        show(ok);
        // reset after a while so the demo can replay on re-enter
        setTimeout(resetPerm, 4200);
      }, 420);
    }, 700);
  }

  function resetPerm() {
    permDone = false;
    const msgs = permDemo.querySelectorAll('.mw-msg');
    // keep first message, rebuild banner
    msgs.forEach((m, i) => { if (i > 0) m.remove(); });
    const banner = document.createElement('div');
    banner.className = 'mw-perm';
    banner.id = 'permBanner';
    banner.innerHTML = `
      <div class="mw-perm-head">
        <span class="pulse"></span>
        <span class="mw-perm-kick">需要你的允许</span>
        <span class="mw-perm-meta">Mia · 日程</span>
      </div>
      <div class="mw-perm-cmd">创建提醒: 明晚 22:00 复习展示稿</div>
      <div class="mw-perm-actions">
        <span class="ghost">拒绝</span>
        <button class="mw-pbtn">仅这次</button>
        <button class="mw-pbtn primary" id="permAllow">允许</button>
      </div>`;
    permDemo.appendChild(banner);
    rebindPerm();
  }

  function rebindPerm() {
    const a = document.getElementById('permAllow');
    const b = document.getElementById('permBanner');
    if (a) a.addEventListener('click', approveLive);
  }
  function approveLive() {
    // re-fetch nodes since they were rebuilt
    const banner = document.getElementById('permBanner');
    const allow = document.getElementById('permAllow');
    if (!banner || permDone) return;
    permDone = true;
    allow.textContent = '已允许 ✓';
    allow.style.background = 'var(--green)';
    setTimeout(() => {
      banner.style.transition = 'opacity .4s, transform .4s';
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-6px)';
      setTimeout(() => {
        const ok = bubble({ av: AV.analyst, html: '已创建提醒。明晚 22:00 我会叫你复习展示稿。' });
        banner.replaceWith(ok);
        show(ok);
        setTimeout(resetPerm, 4200);
      }, 420);
    }, 700);
  }

  if (permAllow) permAllow.addEventListener('click', approveLive);

  /* ---------- kick off demos when they enter view ---------- */
  function once(el, fn) {
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { fn(); io.disconnect(); }
      });
    }, { threshold: 0.25 });
    io.observe(el);
  }

  // hero plays immediately (above fold)
  if (heroBody) playHero();
  once(groupBody, playGroup);
  // auto-approve the static perm demo first time it's seen (then it loops via reset)
  once(permDemo, () => setTimeout(approveLive, 1400));

})();

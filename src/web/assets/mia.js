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
  };
  const HUE = { coder: 'teal', detective: 'indigo', analyst: 'violet', camera: 'rose', coffee: 'amber' };
  const AV = { coder: 'coder', detective: 'detective', analyst: 'analyst', camera: 'camera', coffee: 'coffee' };
  const avHTML = (role) =>
    `<div class="mw-av av av--${HUE[role] || 'indigo'}"><svg viewBox="0 0 24 24">${ICON[role] || ICON.coder}</svg></div>`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const DOWNLOADS = {
    'mac-apple': {
      href: '/downloads/mia-macos-apple-silicon-latest.dmg',
      download: 'Mia-0.1.12-Apple-Silicon.dmg',
      label: '下载 macOS 版',
      shortLabel: '下载',
      icon: 'apple'
    },
    'mac-intel': {
      href: '/downloads/mia-macos-intel-latest.dmg',
      download: 'Mia-0.1.12-Intel.dmg',
      label: '下载 Intel Mac 版',
      shortLabel: 'Intel Mac',
      icon: 'apple'
    },
    windows: {
      href: '/downloads/mia-windows-latest.exe',
      download: 'Mia-0.1.12-Setup.exe',
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
  function bubble({ av, me, html, sender }) {
    const wrap = document.createElement('div');
    wrap.className = 'mw-msg' + (me ? ' me' : '');
    wrap.style.opacity = '0';
    wrap.style.transform = 'translateY(10px)';
    wrap.style.transition = 'opacity .45s cubic-bezier(.16,1,.3,1), transform .45s cubic-bezier(.16,1,.3,1)';
    const avHtml = av ? avHTML(av) : '';
    const senderHtml = sender ? `<div class="demo-sender">${sender}</div>` : '';
    wrap.innerHTML = `${avHtml}<div><div class="mw-bubble${me ? ' me' : ''}">${html}</div></div>`;
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

  /* ============================================================
     HERO — looping scripted conversation
     ============================================================ */
  const heroBody = document.getElementById('heroBody');
  const heroField = document.getElementById('heroField');

  const heroScript = [
    { type: 'user', html: '帮我把新版落地页的测试跑一下,过了就提交' },
    { type: 'typing', av: AV.coder, ms: 1100 },
    { type: 'bot', av: AV.coder, html: '好的,我来跑 <code>npm test</code> →' },
    { type: 'bot', av: AV.coder, html: '✅ 28 个用例全过。测试都过了,我把改动提交一下?' },
    { type: 'perm' },
    { type: 'user', html: '允许 ✓', mini: true },
    { type: 'bot', av: AV.coder, html: '已提交 <code>feat: 新版落地页</code> 🎉 要我顺手发个上线通知到群里吗?' },
  ];

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
        <span class="mw-perm-meta">小柯 · Bash</span>
      </div>
      <div class="mw-perm-cmd">$ git commit -am "feat: 新版落地页"</div>
      <div class="mw-perm-actions">
        <span class="ghost">拒绝</span>
        <button class="mw-pbtn">仅这次</button>
        <button class="mw-pbtn primary">允许</button>
      </div>`;
    return node;
  }

  async function playHero() {
    if (reduceMotion) {
      // static fallback: render a couple of messages
      heroBody.appendChild(show2(bubble({ me: true, html: heroScript[0].html })));
      heroBody.appendChild(show2(bubble({ av: AV.coder, html: heroScript[2].html })));
      heroBody.appendChild(show2(bubble({ av: AV.coder, html: heroScript[3].html })));
      return;
    }
    while (true) {
      heroBody.innerHTML = '';
      for (const step of heroScript) {
        if (step.type === 'user') {
          if (step.mini) {
            // typed in the field then "sent"
            await typeField('允许并继续');
            await wait(250);
            heroField.textContent = '输入消息,Enter 发送…';
          }
          const n = bubble({ me: true, html: step.html });
          heroBody.appendChild(n);
          show(n);
          scrollChat(heroBody);
          await wait(900);
        } else if (step.type === 'typing') {
          const t = typingBubble(step.av);
          heroBody.appendChild(t);
          show(t);
          scrollChat(heroBody);
          await wait(step.ms || 1000);
          t.remove();
        } else if (step.type === 'bot') {
          const n = bubble({ av: step.av, html: step.html });
          heroBody.appendChild(n);
          show(n);
          scrollChat(heroBody);
          await wait(1500);
        } else if (step.type === 'perm') {
          const p = heroPerm();
          heroBody.appendChild(p);
          show(p);
          scrollChat(heroBody);
          await wait(1400);
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
      await wait(2600);
      // fade out before looping
      heroBody.style.transition = 'opacity .5s';
      heroBody.style.opacity = '0';
      await wait(520);
      heroBody.style.opacity = '1';
    }
  }

  async function typeField(text) {
    heroField.style.color = 'var(--ink)';
    for (let i = 1; i <= text.length; i++) {
      heroField.textContent = text.slice(0, i);
      await wait(55);
    }
    await wait(200);
    heroField.style.color = '';
  }

  function scrollChat(el) {
    el.scrollTop = el.scrollHeight;
  }
  function show2(n) { n.style.opacity = '1'; n.style.transform = 'none'; return n; }

  /* ============================================================
     GROUP DEMO — cascade when in view (loops)
     ============================================================ */
  const groupBody = document.getElementById('groupBody');
  const groupScript = [
    { me: true, html: '<span class="mention">@阿研</span> 查下竞品定价,<span class="mention">@阿析</span> 拉一下上周转化' },
    { typing: AV.detective, ms: 1200 },
    { av: AV.detective, sender: '阿研 · 调研', html: '竞品三家定价整理好了,平均比我们高约 20%。详细对比发群文件了 📄' },
    { typing: AV.analyst, ms: 1100 },
    { av: AV.analyst, sender: '阿析 · 数据', html: '上周转化 3.4%,环比 <code>+12%</code>。涨幅主要来自移动端。' },
    { typing: AV.coder, ms: 1300 },
    { av: AV.coder, sender: '小柯 · 工程', html: '那我按这个方向改价格页,改完 @ 你确认 👌' },
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
        const ok = bubble({ av: AV.coder, html: '已提交改动 🎉 <code>feat: 新版落地页</code>' });
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
        <span class="mw-perm-meta">小柯 · Bash</span>
      </div>
      <div class="mw-perm-cmd">$ git commit -am "feat: 新版落地页"</div>
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
        const ok = bubble({ av: AV.coder, html: '已提交改动 🎉 <code>feat: 新版落地页</code>' });
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

(function (global) {
  "use strict";

  function renderAvatar(contact, options = {}) {
    const el = document.createElement("span");
    el.className = `avatar contact-avatar${options.className ? " " + options.className : ""}`;
    const avatar = contact && contact.avatar ? contact.avatar : { image: "", crop: null, color: "" };
    const color = avatar.color || global.miaMemberColor?.memberAccentColor(contact?.id || contact?.key || contact?.displayName || "") || "#5e5ce6";
    if (avatar.image) {
      global.miaAvatar.paintAvatar(el, { image: avatar.image, crop: avatar.crop, color });
      return el;
    } else {
      const letter = ((contact?.displayName || "")[0] || "?").toUpperCase();
      el.style.cssText = `background-color:${color};color:#fff;display:inline-flex;align-items:center;justify-content:center;`;
      el.textContent = letter;
    }
    return el;
  }

  global.miaContactAvatar = { renderAvatar };
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
  "use strict";

  function renderAvatar(contact, options = {}) {
    const el = document.createElement("span");
    el.className = `avatar contact-avatar${options.className ? " " + options.className : ""}`;
    const avatar = contact && contact.avatar ? contact.avatar : { image: "", crop: null, color: "" };
    const color = avatar.color || global.miaMemberColor?.memberAccentColor(contact?.id || contact?.key || contact?.displayName || "") || "#5e5ce6";
    const text = avatar.text || Array.from(String(contact?.displayName || contact?.id || contact?.key || "?").trim()).slice(0, 2).join("") || "?";
    global.miaAvatar.paintAvatar(el, {
      image: avatar.image || "",
      crop: avatar.crop || null,
      color,
      text
    });
    return el;
  }

  global.miaContactAvatar = { renderAvatar };
})(typeof window !== "undefined" ? window : globalThis);

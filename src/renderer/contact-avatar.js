(function (global) {
  "use strict";

  function renderAvatar(contact, options = {}) {
    const el = document.createElement("span");
    el.className = `avatar contact-avatar${options.className ? " " + options.className : ""}`;
    const avatar = contact && contact.avatar ? contact.avatar : { image: "", crop: null, color: "" };
    const color = avatar.color || "#5e5ce6";
    if (avatar.image) {
      const helper = global.aimashiAvatar?.avatarThumbBackgroundStyle;
      let style = "";
      if (typeof helper === "function") style = helper(avatar.image, avatar.crop, color);
      if (!style) style = `background-image:url('${avatar.image}');background-color:${color};background-size:cover;background-position:center;`;
      el.style.cssText = style;
      el.textContent = "";
    } else {
      const letter = ((contact?.displayName || "")[0] || "?").toUpperCase();
      el.style.cssText = `background-color:${color};color:#fff;display:inline-flex;align-items:center;justify-content:center;`;
      el.textContent = letter;
    }
    return el;
  }

  global.aimashiContactAvatar = { renderAvatar };
})(typeof window !== "undefined" ? window : globalThis);

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { highlightMentions } = require("../src/shared/mention-render.js");

const members = [
  { member_kind: "fellow", member_ref: "kongling", fellow_name: "空铃" },
  { member_kind: "fellow", member_ref: "mia", fellow_name: "Mia" },
  { member_kind: "user", member_ref: "user_42", username: "boss" }
];

test("wraps matching fellow tokens by ref", () => {
  const html = highlightMentions("@kongling 在吗", members);
  assert.match(html, /<span class="mention" data-member-kind="fellow" data-member-ref="kongling">@空铃<\/span> 在吗/);
});

test("wraps matching fellow tokens by display name (case insensitive)", () => {
  const html = highlightMentions("@mia 看看", members);
  assert.match(html, /<span class="mention" data-member-kind="fellow" data-member-ref="mia">@Mia<\/span>/);
});

test("wraps CJK tokens that match the fellow's display name", () => {
  const html = highlightMentions("@空铃 来一下", members);
  assert.match(html, /<span class="mention" data-member-kind="fellow" data-member-ref="kongling">@空铃<\/span>/);
});

test("wraps user mentions when the token matches a user member", () => {
  const html = highlightMentions("@boss 在群里", members);
  assert.match(html, /<span class="mention" data-member-kind="user" data-member-ref="user_42">@boss<\/span>/);
});

test("leaves unmatched @tokens alone", () => {
  const html = highlightMentions("@unknown 又来", members);
  assert.equal(html, "@unknown 又来");
});

test("respects the \\@ escape", () => {
  const html = highlightMentions("\\@kongling literal", members);
  assert.equal(html, "\\@kongling literal");
});

test("skips tokens inside <pre>, <code>, <a>, and existing .mention spans", () => {
  const original =
    "<p>say @kongling here</p>" +
    "<pre>@kongling no-wrap</pre>" +
    "<p>read <code>@mia</code> verbatim</p>" +
    `<p>visit <a href="#">@kongling</a> profile</p>` +
    `<p>already <span class="mention">@kongling</span> chip</p>`;
  const html = highlightMentions(original, members);
  // Outside-tag tokens get wrapped exactly once.
  const wrapped = html.match(/<span class="mention"[^>]*>@空铃<\/span>/g) || [];
  assert.equal(wrapped.length, 1, "only the bare paragraph token should be wrapped");
  // The four protected occurrences survive verbatim.
  assert.match(html, /<pre>@kongling no-wrap<\/pre>/);
  assert.match(html, /<code>@mia<\/code>/);
  assert.match(html, /<a href="#">@kongling<\/a>/);
  assert.match(html, /<span class="mention">@kongling<\/span>/);
});

test("returns the input unchanged when there are no members to resolve against", () => {
  const html = highlightMentions("@kongling here", []);
  assert.equal(html, "@kongling here");
});

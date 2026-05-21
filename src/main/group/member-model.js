function makeFellowMember(fellowId, options = {}) {
  const id = String(fellowId || "").trim();
  if (!id) throw new Error("fellowId is required");
  return { kind: "fellow", fellowId: id, ownerId: options.ownerId ?? null };
}

function isFellowMember(value) {
  return Boolean(value) && typeof value === "object" && value.kind === "fellow" && typeof value.fellowId === "string" && value.fellowId.length > 0;
}

function memberKey(member) {
  if (isFellowMember(member)) return "fellow:" + member.fellowId;
  throw new Error("unsupported member kind: " + (member && member.kind));
}

function normalizeMember(input) {
  if (input == null) throw new Error("member is required");
  if (typeof input === "string") return makeFellowMember(input);
  if (typeof input !== "object") throw new Error("member must be object or legacy string");
  if (input.kind === "fellow") return makeFellowMember(input.fellowId, { ownerId: input.ownerId ?? null });
  throw new Error("unsupported member kind: " + input.kind);
}

function normalizeMembersList(input) {
  if (!Array.isArray(input)) throw new Error("members must be an array");
  return input.map(normalizeMember);
}

function membersIncludeKey(members, key) {
  if (!Array.isArray(members)) return false;
  return members.some((m) => {
    if (!isFellowMember(m)) return false;
    return memberKey(m) === key;
  });
}

module.exports = {
  makeFellowMember,
  isFellowMember,
  memberKey,
  normalizeMember,
  normalizeMembersList,
  membersIncludeKey,
};

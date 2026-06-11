import type { Friend, FriendRequest } from "../api/types";

export type FriendRequestDirection = "incoming" | "outgoing";

export function friendName(friend?: Friend | null, fallback = "用户"): string {
  const value = friend?.username || friend?.account || friend?.id || fallback;
  return String(value || fallback);
}

export function friendRequestPeerName(request: FriendRequest, direction: FriendRequestDirection): string {
  const peer = request.other || (direction === "incoming" ? request.sender : request.recipient);
  const fallback =
    direction === "incoming"
      ? request.from_user || request.senderId || request.id
      : request.to_user || request.recipientId || request.id;
  return friendName(peer, String(fallback || "用户"));
}

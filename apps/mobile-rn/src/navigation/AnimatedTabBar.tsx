import { useRef } from "react";
import { View, Pressable, Text, StyleSheet, Animated, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import LottieIcon, { type LottieIconName } from "../ui/LottieIcon";
import { color } from "../theme";
import { mobileTabBarChrome } from "../logic/mobileTabBarChrome";

const LABELS: Record<string, string> = {
  Messages: "消息",
  Contacts: "联系人",
  Agents: "运行",
  Skills: "技能",
  Settings: "设置",
};

// Desktop rail plays only frames 70→130 on activation (data-lottie-play), then
// settles on frame 60 — a ~1s flourish, not the full 2–4s draw. Module-level so
// the array reference stays stable across renders.
const RAIL_PLAY_SEGMENT: [number, number] = [70, 130];

// Match the desktop nav rail's Lottie icon set (src/renderer/assets/lottie).
const TAB_ICON: Record<string, LottieIconName> = {
  Messages: "chat",
  Contacts: "contacts",
  Agents: "checklist",
  Skills: "extension",
  Settings: "settings",
};

function tabFeedback() {
  if (Platform.OS === "android") {
    Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Segment_Tick).catch(() => {});
  } else {
    Haptics.selectionAsync().catch(() => {});
  }
}

function badgeText(value: number): string {
  if (!value || value < 1) return "";
  return value > 99 ? "99+" : String(value);
}

function TabItem({ routeName, focused, badge, onPress }: { routeName: string; focused: boolean; badge?: number; onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;

  const handle = () => {
    // 点击动画:快速放大再弹回(对齐桌面 rail 图标点击反馈)
    Animated.sequence([
      Animated.timing(scale, { toValue: 1.35, duration: 110, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
    ]).start();
    tabFeedback();
    onPress();
  };

  const tint = focused ? color.accent : color.inkFaint;
  const visibleBadge = badgeText(Number(badge) || 0);
  return (
    <Pressable style={styles.item} onPress={handle} hitSlop={8}>
      <Animated.View style={[styles.iconWrap, { transform: [{ scale }] }]}>
        {/* Match the desktop rail: rest on frame 60, and on focus play only the
            short [70,130] window (≈1s) instead of the whole 2–4s draw. */}
        <LottieIcon
          name={TAB_ICON[routeName] || "chat"}
          size={24}
          color={tint}
          dimmed={!focused}
          play={focused}
          restFrame={60}
          playSegment={RAIL_PLAY_SEGMENT}
        />
        {visibleBadge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{visibleBadge}</Text>
          </View>
        ) : null}
      </Animated.View>
      <Text style={[styles.label, { color: tint }]}>{LABELS[routeName] || routeName}</Text>
    </Pressable>
  );
}

export default function AnimatedTabBar({ state, navigation, badges = {} }: BottomTabBarProps & { badges?: Record<string, number> }) {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.bar, { paddingBottom: Math.max(insets.bottom + mobileTabBarChrome.bottomGap, 14) }]}>
      <View pointerEvents="auto" style={styles.card}>
        <View pointerEvents="none" style={styles.glassClip}>
          <View style={styles.frostedVeil} />
          <View style={styles.innerHighlight} />
        </View>
        <View style={styles.items}>
          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const onPress = () => {
              const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            };
            return <TabItem key={route.key} routeName={route.name} focused={focused} badge={badges[route.name]} onPress={onPress} />;
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: mobileTabBarChrome.overlay.position,
    left: mobileTabBarChrome.overlay.left,
    right: mobileTabBarChrome.overlay.right,
    bottom: mobileTabBarChrome.overlay.bottom,
    zIndex: 20,
    backgroundColor: "transparent",
    paddingHorizontal: mobileTabBarChrome.horizontalMargin,
    paddingTop: mobileTabBarChrome.topGap,
  },
  card: {
    minHeight: 62,
    borderRadius: mobileTabBarChrome.cardRadius,
    backgroundColor: mobileTabBarChrome.cardBackgroundColor,
    borderColor: mobileTabBarChrome.cardBorderColor,
    borderWidth: mobileTabBarChrome.cardBorderWidth,
    shadowColor: "#111827",
    shadowOpacity: mobileTabBarChrome.shadowOpacity,
    shadowRadius: mobileTabBarChrome.shadowRadius,
    shadowOffset: { width: 0, height: 8 },
    elevation: mobileTabBarChrome.elevation,
  },
  glassClip: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: mobileTabBarChrome.cardRadius,
    overflow: "hidden",
  },
  frostedVeil: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: mobileTabBarChrome.frostedVeilColor,
  },
  innerHighlight: {
    position: "absolute",
    top: 1,
    left: 14,
    right: 14,
    height: 18,
    borderRadius: 12,
    backgroundColor: mobileTabBarChrome.innerHighlightColor,
  },
  items: {
    flexDirection: "row",
    minHeight: 62,
    zIndex: 1,
  },
  item: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 8, paddingBottom: 6, gap: 3 },
  iconWrap: { width: 28, height: 24, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 11 },
  badge: {
    position: "absolute",
    top: -5,
    right: -8,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: color.danger,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: color.bg,
  },
  badgeText: { color: "#FFFFFF", fontSize: 10, fontWeight: "700" },
});

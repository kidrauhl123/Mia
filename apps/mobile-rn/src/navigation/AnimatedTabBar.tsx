import { useRef } from "react";
import { View, Pressable, Text, StyleSheet, Animated, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import LottieIcon, { type LottieIconName } from "../ui/LottieIcon";
import { color, hairlineWidth } from "../theme";

const LABELS: Record<string, string> = {
  Messages: "消息",
  Contacts: "联系人",
  Agents: "运行",
  Skills: "技能",
  Settings: "设置",
};

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

function TabItem({ routeName, focused, onPress }: { routeName: string; focused: boolean; onPress: () => void }) {
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
  return (
    <Pressable style={styles.item} onPress={handle} hitSlop={8}>
      <Animated.View style={[styles.iconWrap, { transform: [{ scale }] }]}>
        {/* Idle icons render a static last frame (idleProgress=1) and never
            animate; only the focused tab plays, once. */}
        <LottieIcon
          name={TAB_ICON[routeName] || "chat"}
          size={24}
          color={tint}
          dimmed={!focused}
          play={focused}
          idleProgress={1}
        />
      </Animated.View>
      <Text style={[styles.label, { color: tint }]}>{LABELS[routeName] || routeName}</Text>
    </Pressable>
  );
}

export default function AnimatedTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const onPress = () => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };
        return <TabItem key={route.key} routeName={route.name} focused={focused} onPress={onPress} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: color.bg,
    borderTopWidth: hairlineWidth,
    borderTopColor: color.line,
  },
  item: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 8, paddingBottom: 6, gap: 3 },
  iconWrap: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 11 },
});

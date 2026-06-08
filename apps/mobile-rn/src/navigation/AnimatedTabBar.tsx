import { useRef } from "react";
import { View, Pressable, Text, StyleSheet, Animated, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import Svg, { Path, Rect } from "react-native-svg";
import { color, hairlineWidth } from "../theme";

const LABELS: Record<string, string> = {
  Messages: "消息",
  Contacts: "联系人",
  Agents: "运行",
  Skills: "技能",
  Settings: "设置",
};

function RailIcon({ routeName, tint }: { routeName: string; tint: string }) {
  const common = { fill: "none", stroke: tint, strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (routeName === "Messages") {
    return (
      <Svg viewBox="0 0 24 24" width={23} height={23}>
        <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" {...common} />
      </Svg>
    );
  }
  if (routeName === "Contacts") {
    return (
      <Svg viewBox="0 0 24 24" width={23} height={23}>
        <Path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z" {...common} />
      </Svg>
    );
  }
  if (routeName === "Agents") {
    return (
      <Svg viewBox="0 0 24 24" width={23} height={23}>
        <Rect x={3} y={5} width={18} height={16} rx={2} {...common} />
        <Path d="M3 9h18 M8 3v4 M16 3v4 M8 13h3 M8 17h7" {...common} />
      </Svg>
    );
  }
  if (routeName === "Skills") {
    return (
      <Svg viewBox="0 0 24 24" width={23} height={23}>
        <Path d="M12 7v14 M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" {...common} />
      </Svg>
    );
  }
  return (
    <Svg viewBox="0 0 24 24" width={23} height={23}>
      <Path d="M4 6h16 M4 12h16 M4 18h16" {...common} />
    </Svg>
  );
}

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
        <RailIcon routeName={routeName} tint={tint} />
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

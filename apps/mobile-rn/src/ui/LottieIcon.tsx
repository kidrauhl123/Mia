import { useEffect, useRef } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

// lottie-react-native is a native module; absent in the node/jest env. Fall back
// to an empty box there so screens still render and tests stay green.
let LottieView: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  LottieView = require("lottie-react-native").default || require("lottie-react-native");
} catch {
  LottieView = null;
}

// Desktop's shared Lottie icon set (src/renderer/assets/lottie), bundled so the
// mobile UI matches the desktop nav/composer iconography instead of hand-drawn
// SVG paths.
const SOURCES = {
  bell: require("../../assets/lottie/bell.json"),
  chat: require("../../assets/lottie/chat.json"),
  checklist: require("../../assets/lottie/checklist.json"),
  chemistry: require("../../assets/lottie/chemistry.json"),
  contacts: require("../../assets/lottie/contacts.json"),
  copy: require("../../assets/lottie/copy.json"),
  edit: require("../../assets/lottie/edit.json"),
  extension: require("../../assets/lottie/extension.json"),
  forum: require("../../assets/lottie/forum.json"),
  pin: require("../../assets/lottie/pin.json"),
  plusToX: require("../../assets/lottie/plusToX.json"),
  rainbow: require("../../assets/lottie/rainbow.json"),
  reply: require("../../assets/lottie/reply.json"),
  send: require("../../assets/lottie/send.json"),
  settings: require("../../assets/lottie/settings.json"),
  translate: require("../../assets/lottie/translate.json"),
  trash: require("../../assets/lottie/trash.json"),
  welcome: require("../../assets/lottie/welcome.json"),
} as const;

export type LottieIconName = keyof typeof SOURCES;

// Lordicon recolor keypaths. RN Lottie has no CSS currentColor, so recoloring is
// best-effort via colorFilters; active/inactive is ALSO conveyed by opacity so
// the icon still reads correctly even if a keypath doesn't match a given file.
const RECOLOR_KEYPATHS = [".primary", ".primary.design", ".secondary", ".secondary.design"];

interface Props {
  name: LottieIconName;
  size?: number;
  color?: string;
  /** Dim to convey an inactive/disabled state. */
  dimmed?: boolean;
  /** Replay once each time this flips to true (e.g. on tab focus). */
  play?: boolean;
  loop?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function LottieIcon({ name, size = 24, color, dimmed, play, loop = false, style }: Props) {
  const ref = useRef<any>(null);
  const source = SOURCES[name];
  const colorFilters = color ? RECOLOR_KEYPATHS.map((keypath) => ({ keypath, color })) : undefined;

  useEffect(() => {
    if (play && ref.current?.play) {
      try {
        ref.current.reset?.();
        ref.current.play();
      } catch {
        /* no-op */
      }
    }
  }, [play]);

  const box: StyleProp<ViewStyle> = [{ width: size, height: size, opacity: dimmed ? 0.45 : 1 }, style];
  if (!LottieView || !source) return <View style={box} />;
  return (
    <View style={box}>
      <LottieView
        ref={ref}
        source={source}
        autoPlay={loop}
        loop={loop}
        colorFilters={colorFilters}
        style={{ width: size, height: size }}
      />
    </View>
  );
}

import { useMemo } from "react";
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
  /** While true, play the animation once (e.g. on tab focus). Static otherwise. */
  play?: boolean;
  loop?: boolean;
  /** Frame to rest on while not playing: 0 = first frame, 1 = last. Default 0. */
  idleProgress?: number;
  /** Playback rate. >1 makes the flourish quicker. Default 1. */
  speed?: number;
  style?: StyleProp<ViewStyle>;
}

export default function LottieIcon({
  name,
  size = 24,
  color,
  dimmed,
  play,
  loop = false,
  idleProgress = 0,
  speed = 1,
  style,
}: Props) {
  const source = SOURCES[name];
  // Stable reference: a fresh array each render makes RN Lottie re-apply color
  // filters, which restarts playback.
  const colorFilters = useMemo(
    () => (color ? RECOLOR_KEYPATHS.map((keypath) => ({ keypath, color })) : undefined),
    [color]
  );

  const box: StyleProp<ViewStyle> = [{ width: size, height: size, opacity: dimmed ? 0.45 : 1 }, style];
  const inner = { width: size, height: size };
  if (!LottieView || !source) return <View style={box} />;

  // Two mutually-exclusive instances with distinct keys: switching between them
  // remounts. The idle instance is a single frozen frame and NEVER animates, so
  // de-focusing a tab can't replay its icon. The play instance mounts fresh on
  // each focus gain and autoPlays exactly once, then rests on its last frame.
  return (
    <View style={box}>
      {play ? (
        <LottieView key="play" source={source} autoPlay loop={loop} speed={speed} colorFilters={colorFilters} style={inner} />
      ) : (
        <LottieView
          key="idle"
          source={source}
          autoPlay={false}
          loop={false}
          progress={idleProgress}
          colorFilters={colorFilters}
          style={inner}
        />
      )}
    </View>
  );
}

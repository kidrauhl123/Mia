import { useMemo, useRef } from "react";
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
  /** While true, play the flourish segment once (e.g. on tab focus). */
  play?: boolean;
  loop?: boolean;
  /** Absolute frame to rest on when idle (desktop rail uses 60). Default 0. */
  restFrame?: number;
  /** [start, end] absolute frames to play on focus (desktop rail uses [70, 130]).
      Like the desktop, we play only this short window — not the whole 2–4s draw —
      then settle back on restFrame. */
  playSegment?: [number, number];
  style?: StyleProp<ViewStyle>;
}

// Plays a short frame segment once on mount (focus gain), then settles back to
// the rest frame — mirrors the desktop rail's playSegments()+goToAndStop().
function FlourishIcon({
  source,
  segment,
  restFrame,
  colorFilters,
  style,
}: {
  source: any;
  segment: [number, number];
  restFrame: number;
  colorFilters: any;
  style: any;
}) {
  const ref = useRef<any>(null);
  const started = useRef(false);
  const settling = useRef(false);

  const begin = () => {
    if (started.current) return;
    started.current = true;
    ref.current?.play?.(segment[0], segment[1]);
  };
  const onFinish = () => {
    if (settling.current) return; // the settle's own finish — stop here
    settling.current = true;
    ref.current?.play?.(restFrame, restFrame); // freeze on the rest pose
  };

  return (
    <LottieView
      ref={ref}
      source={source}
      autoPlay={false}
      loop={false}
      onLayout={begin}
      onAnimationFinish={onFinish}
      colorFilters={colorFilters}
      style={style}
    />
  );
}

export default function LottieIcon({
  name,
  size = 24,
  color,
  dimmed,
  play,
  restFrame = 0,
  playSegment,
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

  // Normalize the rest frame to 0..1 for the idle instance (op = JSON out-point).
  const op = Math.max(1, Math.floor(Number(source.op) || 1));
  const ip = Math.max(0, Math.floor(Number(source.ip) || 0));
  const restProgress = Math.min(1, Math.max(0, (restFrame - ip) / Math.max(1, op - ip)));

  // Two mutually-exclusive instances. Idle is a single frozen frame and NEVER
  // animates, so siblings can't replay it. Focused mounts a fresh FlourishIcon
  // that plays the short segment once, then settles back to the rest frame.
  return (
    <View style={box}>
      {play && playSegment ? (
        <FlourishIcon
          key="play"
          source={source}
          segment={playSegment}
          restFrame={restFrame}
          colorFilters={colorFilters}
          style={inner}
        />
      ) : (
        <LottieView
          key="idle"
          source={source}
          autoPlay={false}
          loop={false}
          progress={restProgress}
          colorFilters={colorFilters}
          style={inner}
        />
      )}
    </View>
  );
}

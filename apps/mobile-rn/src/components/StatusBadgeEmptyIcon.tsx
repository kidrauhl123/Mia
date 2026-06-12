import Svg, { Circle, Path } from "react-native-svg";
import { color } from "../theme";

export default function StatusBadgeEmptyIcon({ size = 22, strokeColor = color.inkMuted }: { size?: number; strokeColor?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 3.75a8.25 8.25 0 1 1 0 16.5 8.25 8.25 0 0 1 0-16.5Z"
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.65}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={[2.4, 2.1]}
      />
      <Circle cx={9.4} cy={10.5} r={0.78} fill={strokeColor} />
      <Circle cx={14.6} cy={10.5} r={0.78} fill={strokeColor} />
      <Path
        d="M8.9 14.3c1.4 1.5 4.8 1.5 6.2 0"
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.65}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

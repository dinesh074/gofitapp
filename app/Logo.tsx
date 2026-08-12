import React from "react";
import Svg, { Path, Ellipse } from "react-native-svg";
import { colors } from "./theme";

// gofit.today brand mark: a bowl with a sprouting leaf — "healthy food + growth".
// tone="light" renders a white mark (for dark/gradient backgrounds);
// tone="brand" renders a green mark (for light backgrounds).
type Props = { size?: number; tone?: "light" | "brand" };

export default function Logo({ size = 48, tone = "brand" }: Props) {
  const mark = tone === "light" ? "#FFFFFF" : colors.green;
  const vein = tone === "light" ? "rgba(11,122,75,0.55)" : "rgba(255,255,255,0.7)";
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* leaf — tilted asymmetric sprig (not a vertical flame) */}
      <Path
        d="M23.5 24 C21.5 16 26 9.5 33.5 7 C33 14 30 21 23.5 24 Z"
        fill={mark}
      />
      <Path
        d="M23.5 24 C26.5 19 30.5 12.5 32.5 8.5"
        stroke={vein}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* bowl body */}
      <Path d="M8.5 26 A15.5 15.5 0 0 0 39.5 26 Z" fill={mark} />
      {/* bowl rim */}
      <Ellipse cx={24} cy={26} rx={15.5} ry={3.4} fill={mark} />
      <Path
        d="M11 27.6 a13 3 0 0 0 26 0"
        stroke={vein}
        strokeWidth={1.4}
        fill="none"
        strokeLinecap="round"
      />
    </Svg>
  );
}

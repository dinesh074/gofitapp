// Shared design system — one source of truth for colour, type, spacing, radius
// and elevation so every screen has a consistent, premium, non-generic look.

export const colors = {
  // Brand
  green: "#0B7A4B",
  greenDark: "#095C39",
  greenSoft: "#12945C",
  greenTint: "#EAF4EE",
  greenTint2: "#F0F8F3",
  // Surfaces (layered neutrals, not flat grey)
  bg: "#F6F8F7",
  bgElevated: "#FFFFFF",
  card: "#FFFFFF",
  cardMuted: "#F4F7F5",
  // Ink (text) — a proper tonal ramp instead of one grey
  ink: "#141A17",
  inkSoft: "#3C4844",
  mute: "#8A938E",
  faint: "#AEB6B1",
  // Lines & tracks
  line: "#ECEFEE",
  hairline: "#E4E9E6",
  track: "#EAEFEB",
  // Accents (macro + status)
  protein: "#2F80ED",
  carbs: "#E1A500",
  fat: "#E4572E",
  orange: "#E67E22",
  gold: "#E1A500",
  red: "#C0392B",
  redTint: "#FDECEA",
  success: "#0B7A4B",
  white: "#FFFFFF",
};

// Gradient pairs for headers / hero surfaces.
export const gradients = {
  brand: ["#0E8A55", "#0B6E43"] as const,
  brandDeep: ["#0B7A4B", "#064A2E"] as const,
  ring: ["#12A566", "#0B7A4B"] as const,
};

export const radius = { xs: 8, sm: 12, md: 16, lg: 20, xl: 24, pill: 999 };

// Elevation ramp — soft, layered shadows (Linear/Apple-style) not harsh drops.
export const elevation = {
  none: {},
  sm: {
    shadowColor: "#0B211A",
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  md: {
    shadowColor: "#0B211A",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  lg: {
    shadowColor: "#0B211A",
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
};

// Back-compat alias (older screens import `shadow.card`).
export const shadow = { card: elevation.sm };

// Type scale — consistent sizing/weight/spacing removes the "AI default" feel.
export const type = {
  display: { fontSize: 34, fontWeight: "800" as const, letterSpacing: -0.5 },
  h1: { fontSize: 26, fontWeight: "800" as const, letterSpacing: -0.3 },
  h2: { fontSize: 21, fontWeight: "700" as const, letterSpacing: -0.2 },
  title: { fontSize: 17, fontWeight: "700" as const },
  body: { fontSize: 15, fontWeight: "500" as const },
  bodyStrong: { fontSize: 15, fontWeight: "700" as const },
  caption: { fontSize: 13, fontWeight: "600" as const },
  tiny: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.3 },
  overline: { fontSize: 11, fontWeight: "800" as const, letterSpacing: 1.2 },
};

// 4-pt spacing scale helper.
export function sp(n: number): number {
  return n * 4;
}

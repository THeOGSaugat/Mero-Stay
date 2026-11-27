import type { SVGProps } from "react";

/**
 * Inline line icons (Phase 13 design system): no icon font or library, so pages stay light on
 * mobile data. Decorative by default (aria-hidden); give an accessible name with a visible label.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, className = "size-5", ...rest }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
    <circle cx="12" cy="10" r="2.3" />
  </Svg>
);
export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5" />
    <path d="M16 5.5a3 3 0 0 1 0 6M18 14.6c1.6.7 2.6 2.4 3 4.9" />
  </Svg>
);
export const IconBed = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 18V7M3 13h18v5M21 13v-2.5A2.5 2.5 0 0 0 18.5 8H11v5" />
    <circle cx="7" cy="10.5" r="1.8" />
  </Svg>
);
export const IconBus = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="3.5" width="15" height="14" rx="2.5" />
    <path d="M4.5 11h15M7.5 17.5v2.5M16.5 17.5v2.5" />
    <circle cx="8" cy="14.3" r=".6" fill="currentColor" />
    <circle cx="16" cy="14.3" r=".6" fill="currentColor" />
  </Svg>
);
export const IconGuide = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="6.5" r="3" />
    <path d="M6 20.5c.5-4 3-6.5 6-6.5s5.5 2.5 6 6.5" />
    <path d="m15.5 9.5 2.5 1" />
  </Svg>
);
export const IconMountain = (p: IconProps) => (
  <Svg {...p}>
    <path d="m2.5 19.5 6.5-11 4 6.5 2.5-3.5 6 8Z" />
    <path d="m7.4 11.3 1.6 1.2 1.4-1.4" />
  </Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6Z" />
    <path d="m8.8 12 2.2 2.2 4.2-4.4" />
  </Svg>
);
export const IconTag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9Z" />
    <circle cx="8" cy="8" r="1.4" />
  </Svg>
);
export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.5h16v10H9l-5 4Z" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconMap = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 6 5.5-2 6 2 5.5-2v14l-5.5 2-6-2-5.5 2Z" />
    <path d="M9 4v14M15 6v14" />
  </Svg>
);

/** The MeroStay mark: a mountain ridge (white on the green header, green elsewhere). */
export function LogoMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 40 28" className={className}>
      <path d="M1 26 13 5l7 11 4-6 15 16Z" fill="currentColor" />
      <path d="m10 11 3-6 3.5 5.5-2 1.5-1.5-2-1.5 2Z" fill="var(--color-accent)" />
    </svg>
  );
}

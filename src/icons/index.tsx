import type { SVGProps } from "react";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "stroke"> {
  w?: number;
  stroke?: number;
}

const I = ({ w = 18, stroke = 1.5, children, ...rest }: IconProps & { children: React.ReactNode }) => (
  <svg
    width={w}
    height={w}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    {children}
  </svg>
);

export const IconHome = (p: IconProps) => (
  <I {...p}><path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z" /></I>
);
export const IconInbox = (p: IconProps) => (
  <I {...p}>
    <path d="M21 14l-4-9H7l-4 9v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z" />
    <path d="M3 14h5l1 2h6l1-2h5" />
  </I>
);
export const IconBot = (p: IconProps) => (
  <I {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 3v4" /><circle cx="12" cy="3" r="1" fill="currentColor" />
    <circle cx="9" cy="13" r="1" fill="currentColor" />
    <circle cx="15" cy="13" r="1" fill="currentColor" />
    <path d="M9 17h6" />
    <path d="M2 12v3" /><path d="M22 12v3" />
  </I>
);
export const IconCampaign = (p: IconProps) => (
  <I {...p}>
    <path d="M3 11v2a2 2 0 0 0 2 2h2l4 4V5L7 9H5a2 2 0 0 0-2 2z" />
    <path d="M16 8a4 4 0 0 1 0 8" />
    <path d="M19 5a8 8 0 0 1 0 14" />
  </I>
);
export const IconUsers = (p: IconProps) => (
  <I {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 21v-1a6 6 0 0 1 12 0v1" />
    <circle cx="17" cy="9" r="2.5" />
    <path d="M15 14h2a4 4 0 0 1 4 4v1" />
  </I>
);
export const IconFlow = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="15" y="3" width="6" height="6" rx="1" />
    <rect x="9" y="15" width="6" height="6" rx="1" />
    <path d="M6 9v3h12V9" /><path d="M12 12v3" />
  </I>
);
export const IconChart = (p: IconProps) => (
  <I {...p}><path d="M3 3v18h18" /><path d="M7 14l3-4 3 3 5-7" /></I>
);
export const IconTemplate = (p: IconProps) => (
  <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></I>
);
export const IconTeam = (p: IconProps) => (
  <I {...p}><circle cx="12" cy="8" r="3" /><path d="M5 21v-1a7 7 0 0 1 14 0v1" /></I>
);
export const IconBilling = (p: IconProps) => (
  <I {...p}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><path d="M7 15h4" /></I>
);
export const IconCog = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
  </I>
);
export const IconSearch = (p: IconProps) => (
  <I {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></I>
);
export const IconBell = (p: IconProps) => (
  <I {...p}>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </I>
);
export const IconVolume = (p: IconProps) => (
  <I {...p}>
    <path d="M11 5L6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  </I>
);
export const IconVolumeMute = (p: IconProps) => (
  <I {...p}>
    <path d="M11 5L6 9H3v6h3l5 4V5z" />
    <path d="M16 10l4 4M20 10l-4 4" />
  </I>
);
export const IconPlus = (p: IconProps) => <I {...p}><path d="M12 5v14M5 12h14" /></I>;
export const IconChev = (p: IconProps) => <I {...p}><path d="M9 6l6 6-6 6" /></I>;
export const IconChevDown = (p: IconProps) => <I {...p}><path d="M6 9l6 6 6-6" /></I>;
export const IconCheck = (p: IconProps) => <I {...p}><path d="M5 13l4 4L19 7" /></I>;
export const IconX = (p: IconProps) => <I {...p}><path d="M6 6l12 12M18 6l-12 12" /></I>;
export const IconSparkles = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
    <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z" />
  </I>
);
export const IconSend = (p: IconProps) => <I {...p}><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></I>;
export const IconAttach = (p: IconProps) => (
  <I {...p}><path d="M21 12l-8.5 8.5a5 5 0 0 1-7-7L13 5a3.5 3.5 0 0 1 5 5L9.5 18.5a2 2 0 0 1-3-3L14 8" /></I>
);
export const IconPhone = (p: IconProps) => (
  <I {...p}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5 13 13 0 0 0 2.6.6 2 2 0 0 1 1.7 2z" /></I>
);
export const IconTag = (p: IconProps) => (
  <I {...p}><path d="M20.6 13.4L12 22 2 12V2h10z" /><circle cx="7" cy="7" r="1.5" fill="currentColor" /></I>
);
export const IconFilter = (p: IconProps) => <I {...p}><path d="M3 5h18l-7 8v6l-4-2v-4z" /></I>;
export const IconClock = (p: IconProps) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>;
export const IconMore = (p: IconProps) => (
  <I {...p}>
    <circle cx="5" cy="12" r="1.5" fill="currentColor" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    <circle cx="19" cy="12" r="1.5" fill="currentColor" />
  </I>
);
export const IconArrow = (p: IconProps) => <I {...p}><path d="M5 12h14M13 6l6 6-6 6" /></I>;
export const IconArrowUp = (p: IconProps) => <I {...p}><path d="M12 19V5M5 12l7-7 7 7" /></I>;
export const IconArrowDown = (p: IconProps) => <I {...p}><path d="M12 5v14M5 12l7 7 7-7" /></I>;
export const IconBolt = (p: IconProps) => <I {...p}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></I>;
export const IconBook = (p: IconProps) => (
  <I {...p}><path d="M4 4v16a2 2 0 0 0 2 2h14V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z" /><path d="M8 4v18" /></I>
);
export const IconPlay = (p: IconProps) => <I {...p}><path d="M6 4l14 8-14 8z" /></I>;
export const IconPause = (p: IconProps) => (
  <I {...p}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></I>
);
export const IconGlobe = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </I>
);
export const IconStar = (p: IconProps) => <I {...p}><path d="M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" /></I>;
export const IconTrash = (p: IconProps) => (
  <I {...p}>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M5 7l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13" />
    <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
  </I>
);
export const IconArchive = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </I>
);
export const IconCheckCircle = (p: IconProps) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></I>;
export const IconAlert = (p: IconProps) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></I>;
export const IconHand = (p: IconProps) => (
  <I {...p}>
    <path d="M9 11V5a2 2 0 0 1 4 0v6" />
    <path d="M13 11V4a2 2 0 0 1 4 0v9" />
    <path d="M9 11V7a2 2 0 0 0-4 0v8a7 7 0 0 0 7 7h1a6 6 0 0 0 6-6v-3" />
  </I>
);
export const IconRoute = (p: IconProps) => (
  <I {...p}>
    <circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" />
    <path d="M8 19h7a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h6" />
  </I>
);
export const IconLayers = (p: IconProps) => (
  <I {...p}>
    <path d="M12 2l10 5-10 5L2 7z" />
    <path d="M2 12l10 5 10-5" /><path d="M2 17l10 5 10-5" />
  </I>
);
export const IconCal = (p: IconProps) => (
  <I {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></I>
);
export const IconLang = (p: IconProps) => (
  <I {...p}>
    <path d="M3 5h12" /><path d="M9 3v2" /><path d="M5 5c0 7 5 8 8 8" />
    <path d="M11 13c-2 4-5 5-7 5" /><path d="M13 21l4-10 4 10" />
    <path d="M14.5 17h5" />
  </I>
);
export const IconSun = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
  </I>
);
export const IconMoon = (p: IconProps) => (
  <I {...p}><path d="M21 13a9 9 0 1 1-10-10c-.5 4 2 8 6 9 .9.2 2.6.5 4 1z" /></I>
);
export const IconRadar = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <path d="M12 3 L12 12 L19 8" />
  </I>
);

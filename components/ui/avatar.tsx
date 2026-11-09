/** Initials avatar from the chat design. Colour pairs are the design's own; picked by a stable hash of the name. */
const PAIRS = [
  { bg: "#E7E5FF", fg: "#3326B8" },
  { bg: "#E0F2EF", fg: "#0F5F57" },
  { bg: "#FDEBDD", fg: "#9A3F0B" },
  { bg: "#E3EEFD", fg: "#1E4E9A" },
  { bg: "#FCE7F0", fg: "#9D174D" },
  { bg: "#F1F1F3", fg: "#3D3D45" },
] as const;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function avatarColours(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PAIRS[h % PAIRS.length];
}

const SIZES = { xs: [28, 10], tip: [36, 12], sm: [38, 13], md: [42, 14], account: [40, 13], row: [48, 15], lg: [52, 16], xl: [84, 26] } as const;

export function Avatar({
  name,
  src = null,
  size = "md",
  online = false,
  decorative = false,
}: {
  name: string;
  /** A profile photo; without one the avatar shows initials. */
  src?: string | null;
  size?: keyof typeof SIZES;
  online?: boolean;
  decorative?: boolean;
}) {
  const [px, font] = SIZES[size];
  const { bg, fg } = avatarColours(name);
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: px, height: px, fontSize: font, background: bg, color: fg }}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : name}
      role={decorative ? undefined : "img"}
    >
      {src ? (
        // A small fixed-size local photo: next/image would add a loader round trip for no gain.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={px} height={px} className="h-full w-full rounded-full object-cover" />
      ) : (
        initials(name)
      )}
      {online ? (
        <span
          className={`absolute rounded-full border-2 border-ground bg-online ${px === 38 ? "-right-px -bottom-px h-[11px] w-[11px]" : "right-0 bottom-0 h-3 w-3"}`}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

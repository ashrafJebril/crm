interface PhotoSlotProps {
  label?: string;
  w?: number | string;
  h?: number | string;
}

export const PhotoSlot = ({ label = "photo", w = "100%", h = 120 }: PhotoSlotProps) => (
  <div
    style={{
      width: w,
      height: h,
      borderRadius: "var(--r-md)",
      background:
        "repeating-linear-gradient(135deg, var(--bg-2), var(--bg-2) 8px, var(--bg-1) 8px, var(--bg-1) 16px)",
      border: "1px dashed var(--line)",
      display: "grid",
      placeItems: "center",
      color: "var(--ink-3)",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
    }}
  >
    {label}
  </div>
);

import { memo, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";

interface ComingSoonProps {
  titleEn: string;
  titleAr: string;
  subtitleEn?: string;
  subtitleAr?: string;
  children?: ReactNode;
}

function ComingSoonImpl({
  titleEn,
  titleAr,
  subtitleEn = "Wired into the shell. The full screen lands in the next pass.",
  subtitleAr = "تم ربط الشاشة. التفاصيل الكاملة في الإصدار القادم.",
  children,
}: ComingSoonProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader title={tx(titleEn, titleAr)} subtitle={tx(subtitleEn, subtitleAr)} />
      <div style={{ padding: "0 24px 40px" }}>
        <div className="card" style={{ padding: 60, textAlign: "center" }}>
          <div className="display" style={{ fontSize: 56, color: "var(--ink-1)" }}>
            {tx("coming soon", "قريبًا")}
          </div>
          <p style={{ color: "var(--ink-3)", marginTop: 16, fontSize: 13 }}>
            {tx(
              "This screen is part of the broader platform — pick another from the sidebar.",
              "هذه الشاشة جزء من المنصة — اختر شاشة أخرى من الشريط الجانبي.",
            )}
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}

export const ComingSoon = memo(ComingSoonImpl);

/** Default no-prop wrapper used by router placeholder routes. */
export default function ComingSoonPlaceholder() {
  return <ComingSoon titleEn="Coming Soon" titleAr="قريبًا" />;
}

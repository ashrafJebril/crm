import { useState } from "react";
import type { Lang, Segment } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { useHashParam } from "@/lib/useHashParam";
import { IconPlus } from "@/icons";
import { ImportChip, ImportWizard } from "./import/ImportWizard";
import { AudienceDetail } from "./audiences/AudienceDetail";
import { AudienceSheet } from "./audiences/AudienceSheet";
import { countedAtLabel } from "./audiences/rulesModel";
import { CountText, IssueDot, SECTION_LABEL, TypeBadge, segName } from "./audiences/ui";

interface AudiencesTabProps {
  tx: Tx;
  lang: Lang;
  /** An audience was created, edited or deleted (the Contacts screen refreshes its chips). */
  onChanged?: () => void;
}

/**
 * SP-16 (ruling 13): the Contacts → Audiences tab. Two sections, "Groups"
 * (hand-picked, plus HJZ snapshots) and "Smart audiences" (rules), and the
 * audience detail page at `#/contacts?ct=audiences&aud=<id>`.
 */
export function AudiencesTab({ tx, lang, onChanged }: AudiencesTabProps) {
  const segmentsQ = useFetch<Segment[]>("/segments");
  const [aud, setAud] = useHashParam("aud");
  const [creating, setCreating] = useState<"smart" | "manual" | null>(null);
  const [importing, setImporting] = useState(false);
  const [importWatchId, setImportWatchId] = useState<string | null>(null);
  const { can } = usePermissions();
  const canCreate = can("audiences.create");
  // Creating a new group needs audiences.create; adding to an existing one, audiences.update.
  const canImport = can("audiences.create") || can("audiences.update");

  const changed = () => {
    void segmentsQ.refetch();
    onChanged?.();
  };

  if (aud) {
    return <AudienceDetail tx={tx} lang={lang} id={aud} onBack={() => setAud(null)} onOpen={(id) => setAud(id)} onChanged={changed} />;
  }

  const rows = segmentsQ.data ?? [];
  const groups = rows.filter((s) => s.origin !== "crm");
  const smart = rows.filter((s) => s.origin === "crm");

  return (
    <div style={{ padding: "0 24px 24px", display: "grid", gap: 18 }}>
      <section>
        <div className="mono" style={{ ...SECTION_LABEL, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>{tx("Smart audiences", "الجماهير الذكية")} · {smart.length}</span>
          {canCreate && (
            <button type="button" className="btn sm primary" style={{ textTransform: "none" }} onClick={() => setCreating("smart")}>
              <IconPlus w={12} /> {tx("New smart audience", "جمهور ذكي جديد")}
            </button>
          )}
        </div>
        {smart.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            {tx(
              "Smart audiences update themselves from rules, such as \"last active within 7 days\" or \"has tag VIP\".",
              "تتحدّث الجماهير الذكية تلقائيًا من الشروط، مثل «آخر نشاط خلال ٧ أيام» أو «لديه الوسم VIP».",
            )}
          </div>
        ) : (
          <div style={GRID}>
            {smart.map((s) => (
              <AudienceCard key={s.id} seg={s} lang={lang} tx={tx} onOpen={() => setAud(s.id)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mono" style={{ ...SECTION_LABEL, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>{tx("Groups", "المجموعات")} · {groups.length}</span>
          <button
            type="button"
            className="btn sm"
            style={{ textTransform: "none" }}
            onClick={() => setImporting(true)}
            disabled={!canImport}
            title={canImport ? undefined : tx(NO_PERMISSION_EN, NO_PERMISSION_AR)}
          >
            {tx("Import file", "استيراد ملف")}
          </button>
          <span style={{ textTransform: "none" }}>
            <ImportChip tx={tx} watchId={importWatchId} onFinished={() => { setImportWatchId(null); changed(); }} />
          </span>
        </div>
        <div style={GRID}>
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreating("manual")}
              style={{
                border: "2px dashed var(--line)", borderRadius: 14, minHeight: 110,
                background: "transparent", cursor: "pointer", display: "grid",
                placeItems: "center", color: "var(--ink-3)", fontSize: 13,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconPlus w={14} /> {tx("New group", "مجموعة جديدة")}
              </span>
            </button>
          )}
          {groups.map((g) => (
            <AudienceCard key={g.id} seg={g} lang={lang} tx={tx} onOpen={() => setAud(g.id)} />
          ))}
        </div>
      </section>

      {segmentsQ.error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{tx("Couldn't load audiences.", "تعذر تحميل الجماهير.")}</div>
      )}

      {creating && (
        <AudienceSheet
          tx={tx}
          lang={lang}
          mode={creating}
          onClose={() => setCreating(null)}
          onSaved={(row) => {
            setCreating(null);
            changed();
            setAud(row.id);
          }}
        />
      )}

      {importing && (
        <ImportWizard
          tx={tx}
          lang={lang}
          kind="audience"
          onClose={(runningId) => {
            setImporting(false);
            if (runningId) setImportWatchId(runningId);
          }}
          onImported={changed}
        />
      )}
    </div>
  );
}

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 } as const;

function AudienceCard({ seg, lang, tx, onOpen }: { seg: Segment; lang: Lang; tx: Tx; onOpen: () => void }) {
  const counted = seg.origin === "crm" ? countedAtLabel(seg.countedAt, tx) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        textAlign: "start", border: "1px solid var(--line-soft)", borderRadius: 14,
        background: "var(--bg-1)", padding: 16, cursor: "pointer",
        display: "flex", flexDirection: "column", gap: 8, minHeight: 110,
        borderInlineStartWidth: 4,
        borderInlineStartColor: seg.color ? `hsl(${seg.color} 70% 45%)` : "var(--line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
        <bdi dir="auto" style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {segName(seg, lang)}
        </bdi>
        <IssueDot count={seg.issues?.length ?? 0} tx={tx} />
        <TypeBadge origin={seg.origin} tx={tx} color={seg.color} />
      </div>
      <CountText
        count={seg.count}
        timedOut={seg.timedOut}
        skipped={seg.skipped}
        tx={tx}
        style={{ fontSize: seg.count === null ? 13 : 26, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: seg.count === null ? "var(--ink-2)" : undefined }}
      />
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>
        {tx("contacts", "جهة اتصال")}
        {counted ? ` · ${counted}` : ""}
      </div>
    </button>
  );
}

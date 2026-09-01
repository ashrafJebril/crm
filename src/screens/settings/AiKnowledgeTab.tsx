import { useMemo, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch, useMutation } from "@/api/useFetch";
import { Badge, type BadgeKind } from "@/components/Badge";
import {
  AUTONOMY_MODES,
  BODY_MAX,
  KNOWLEDGE_KINDS,
  REASON_MAX,
  TITLE_MAX,
  deleteDoc,
  resyncFromHjz,
  saveDoc,
  setAiEnabled,
  setAutonomyMode,
  setSyncEnabled,
  type AiKnowledgeDoc,
  type AiSettings,
  type AutonomyMode,
  type KnowledgeKind,
  type SaveDocResult,
  type SetSyncEnabledResult,
  type SyncEnabledState,
  type SyncResult,
  type ToggleResult,
} from "@/api/aiKnowledge";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "./form";

/**
 * Teach the AI.
 *
 * The agent answers real WhatsApp customers, and until this screen existed
 * everything it knew was loaded by an engineer running curl. This is where the
 * salon owner corrects a wrong answer or adds a policy without a developer.
 *
 * Two classes of document, and the difference matters to the user:
 *  - SYNCED (`editable: false`) — services, branches, staff, pulled from hjz.
 *    Read-only here, because the next sync would silently revert a hand edit.
 *  - OWNER-AUTHORED — everything the salon knows that no upstream API does.
 *
 * Saving is not free: kewy-ai embeds the body inline on every save, so the
 * 100k cap is a cost ceiling as much as a size one and the counter is shown
 * live rather than validated after a long paste.
 */

/**
 * Synced doc titles arrive in the TENANT's locale (Arabic here), so an English
 * UI showed "الطاقم" beside "Synced from hjz" — half the list in each language.
 *
 * The title is only a label, so it follows the UI language. The BODY is left
 * exactly as stored: that text is what the model reads when answering an
 * Arabic-speaking customer, and translating it would make the AI quote English
 * service names in an Arabic reply and mismatch the names in hjz.
 */
const SYNCED_DOC_LABELS: Array<{ match: RegExp; en: string; ar: string }> = [
  { match: /^(الخدمات المتوفرة|Services offered)$/, en: "Services offered", ar: "الخدمات المتوفرة" },
  { match: /^(الفروع والمواقع|Branches and locations)$/, en: "Branches and locations", ar: "الفروع والمواقع" },
  { match: /^(الطاقم|Our team)$/, en: "Our team", ar: "الطاقم" },
];

/** Display title for a synced doc, in the UI language. Owner-written docs keep
 *  their own title — the owner chose those words themselves. */
function displayTitle(title: string, tx: Tx): string {
  const hit = SYNCED_DOC_LABELS.find((s) => s.match.test(title.trim()));
  return hit ? tx(hit.en, hit.ar) : title;
}

/** The badge beside a synced doc: its subject, not SERVICE_DESCRIPTION. */
function syncedLabel(title: string): { en: string; ar: string } | null {
  const hit = SYNCED_DOC_LABELS.find((s) => s.match.test(title.trim()));
  if (!hit) return null;
  return hit.en === "Our team"
    ? { en: "Team", ar: "الطاقم" }
    : hit.en === "Branches and locations"
      ? { en: "Branches", ar: "الفروع" }
      : { en: "Services", ar: "الخدمات" };
}

const KIND_LABELS: Record<KnowledgeKind, { en: string; ar: string }> = {
  POLICY: { en: "Policy", ar: "سياسة" },
  FAQ: { en: "FAQ", ar: "سؤال متكرر" },
  SERVICE_DESCRIPTION: { en: "Service", ar: "وصف خدمة" },
  PROMOTION: { en: "Promotion", ar: "عرض" },
  TONE: { en: "Tone", ar: "أسلوب الرد" },
  OTHER: { en: "Other", ar: "أخرى" },
};

const KIND_BADGE: Record<KnowledgeKind, BadgeKind> = {
  POLICY: "warn",
  FAQ: "info",
  SERVICE_DESCRIPTION: "accent",
  PROMOTION: "ok",
  TONE: "human",
  OTHER: "",
};

/** Only these two. A silently bad PDF/DOCX extraction teaches the AI garbage
 *  that then goes out to customers as fact.
 *  TODO: PDF via pdf-parse and DOCX via mammoth deserve their own pass —
 *  both need testing against real salon price lists before being trusted,
 *  plus a way to show the owner what was dropped (tables, headers, images). */
const ACCEPTED_EXTENSIONS = [".txt", ".md"];

interface DraftState {
  /** Absent = creating. Present = editing that doc. */
  id?: string;
  title: string;
  kind: KnowledgeKind;
  body: string;
  /** Set when the body came from a file, so the editor can say where it's from. */
  sourceFilename?: string;
}

const EMPTY_DRAFT: DraftState = { title: "", kind: "POLICY", body: "" };

export function AiKnowledgeTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();

  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";

  const listQ = useFetch<{ docs: AiKnowledgeDoc[] }>("/ai/knowledge/docs");
  const statusQ = useFetch<{ configured: boolean }>("/ai/knowledge/status");

  const [draft, setDraft] = useState<DraftState | null>(null);
  // Delete is the one destructive, irreversible action here, so it is the one
  // thing that confirms. Inline rather than window.confirm so the doc's title
  // is visible while deciding.
  const [pendingDelete, setPendingDelete] = useState<AiKnowledgeDoc | null>(null);
  // Read-only inspection, separate from `draft` (the editor). Synced docs can't
  // be edited, but the owner still needs to see what the AI is actually working
  // from — a list of titles alone gives no way to tell whether a wrong answer
  // came from wrong knowledge.
  const [viewing, setViewing] = useState<AiKnowledgeDoc | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const saveMut = useMutation<DraftState, SaveDocResult>((d) =>
    saveDoc({ id: d.id, title: d.title.trim(), body: d.body.trim(), kind: d.kind }),
  );
  const deleteMut = useMutation<{ id: string }, { ok: true }>((i) => deleteDoc(i.id));
  const syncMut = useMutation<void, SyncResult>(() => resyncFromHjz());

  // The sync on/off switch. Off = the synced docs are REMOVED and the AI stops
  // using hjz data; on = syncing is allowed again (but nothing pulls until the
  // owner presses re-sync, so the slow part stays visible).
  const syncEnabledQ = useFetch<SyncEnabledState>("/ai/knowledge/sync-enabled");
  const syncToggleMut = useMutation<boolean, SetSyncEnabledResult>((enabled) => setSyncEnabled(enabled));
  // Turning it off deletes data, so it asks once — same inline pattern as doc
  // deletion, because window.confirm hides WHAT will be removed.
  const [confirmSyncOff, setConfirmSyncOff] = useState(false);

  const showStatus = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 3000);
  };

  const docs = listQ.data?.docs ?? [];
  const ownerDocs = useMemo(() => docs.filter((d) => d.editable), [docs]);
  const syncedDocs = useMemo(() => docs.filter((d) => !d.editable), [docs]);

  const onSave = async () => {
    if (!draft) return;
    const res = await saveMut.mutate(draft);
    setDraft(null);
    setFileNote(null);
    listQ.refetch();
    // Report chunksWritten: it is the proof the text was actually embedded and
    // is now reachable by the agent, not merely stored.
    showStatus(
      tx(
        `Saved — the AI learned this in ${res.chunksWritten} chunk${res.chunksWritten === 1 ? "" : "s"}.`,
        `تم الحفظ — صار الذكاء الاصطناعي يعرف هالمعلومة (${res.chunksWritten} مقطع).`,
      ),
    );
  };

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteMut.mutate({ id: pendingDelete.id });
    const title = pendingDelete.title;
    setPendingDelete(null);
    listQ.refetch();
    showStatus(tx(`Deleted "${title}".`, `تم حذف "${title}".`));
  };

  const onSync = async () => {
    setSyncResult(null);
    try {
      const res = await syncMut.mutate();
      const n = Array.isArray(res.synced) ? res.synced.length : 0;
      listQ.refetch();
      setSyncResult(
        tx(
          `Re-synced ${n} document${n === 1 ? "" : "s"} from hjz (services, branches, staff).`,
          `تم تحديث ${n} مستند من hjz (الخدمات والفروع والطاقم).`,
        ),
      );
    } catch {
      /* error stays in syncMut.error */
    }
  };

  const syncEnabled = syncEnabledQ.data?.enabled ?? true;

  const onSyncOff = async () => {
    try {
      const res = await syncToggleMut.mutate(false);
      setConfirmSyncOff(false);
      syncEnabledQ.refetch();
      listQ.refetch();
      setSyncResult(null);
      showStatus(
        tx(
          `Sync is off — ${res.deletedDocs} synced document${res.deletedDocs === 1 ? "" : "s"} removed. The AI no longer uses hjz data.`,
          `التزامن متوقف — انحذف ${res.deletedDocs} مستند. الذكاء الاصطناعي ما عاد يستخدم بيانات hjz.`,
        ),
      );
    } catch {
      /* error stays in syncToggleMut.error */
    }
  };

  const onSyncOn = async () => {
    try {
      await syncToggleMut.mutate(true);
      syncEnabledQ.refetch();
      showStatus(
        tx(
          "Sync is on. Press re-sync to pull your services, branches and staff.",
          "التزامن اشتغل. اضغط تحديث لسحب الخدمات والفروع والطاقم.",
        ),
      );
    } catch {
      /* error stays in syncToggleMut.error */
    }
  };

  if (!activeWorkspace) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        {tx("No active workspace.", "لا توجد مساحة عمل نشطة.")}
      </div>
    );
  }

  // A deployment that never bought the AI module shouldn't show a red error.
  if (statusQ.data && !statusQ.data.configured) {
    return (
      <SettingsCard title={tx("AI Knowledge", "معرفة الذكاء الاصطناعي")}>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
          {tx(
            "The AI assistant isn't set up for this workspace yet. Contact Kewy support to enable it.",
            "المساعد الذكي مش مفعّل لهالمساحة بعد. تواصل مع دعم كيوي لتفعيله.",
          )}
        </div>
      </SettingsCard>
    );
  }

  return (
    <>
      {!draft && <AiAssistantCard tx={tx} canEdit={canEdit} showStatus={showStatus} />}

      {draft ? (
        <DraftEditor
          tx={tx}
          draft={draft}
          setDraft={setDraft}
          onSave={onSave}
          onCancel={() => {
            setDraft(null);
            setFileNote(null);
            setStatus(null);
          }}
          saving={saveMut.loading}
          error={saveMut.error}
          fileNote={fileNote}
          setFileNote={setFileNote}
        />
      ) : (
        <SettingsCard
          title={tx("What the AI knows", "شو بيعرف الذكاء الاصطناعي")}
          description={tx(
            "Anything you write here, the assistant can use when it answers a customer on WhatsApp.",
            "أي شي بتكتبه هون، المساعد بيقدر يستخدمه لما يرد على الزباين على واتساب.",
          )}
          footer={
            canEdit ? (
              <button type="button" className="btn primary" onClick={() => setDraft(EMPTY_DRAFT)}>
                {tx("Add knowledge", "أضف معلومة")}
              </button>
            ) : null
          }
        >
          {listQ.loading && docs.length === 0 ? (
            <div className="mono muted pulse" style={{ fontSize: 12 }}>
              {tx("loading…", "جارٍ التحميل…")}
            </div>
          ) : ownerDocs.length === 0 ? (
            <EmptyState tx={tx} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ownerDocs.map((d) => (
                <DocRow
                  key={d.id}
                  tx={tx}
                  doc={d}
                  canEdit={canEdit}
                  onView={() => setViewing(d)}
                  onEdit={() => setDraft({ id: d.id, title: d.title, kind: d.kind, body: d.body })}
                  onDelete={() => setPendingDelete(d)}
                />
              ))}
            </div>
          )}
          <ErrorRow message={listQ.error ?? deleteMut.error} />
        </SettingsCard>
      )}

      {viewing && <ViewCard tx={tx} doc={viewing} onClose={() => setViewing(null)} />}

      {!draft && canEdit && <FileDropCard tx={tx} onExtracted={setDraft} setFileNote={setFileNote} fileNote={fileNote} />}

      {!draft && (
        <SettingsCard
          title={tx("Synced from hjz", "مسحوب من hjz")}
          description={tx(
            "Services, branches and staff are pulled automatically. They're read-only here — edit them in hjz, then re-sync.",
            "الخدمات والفروع والطاقم بتنسحب تلقائياً. ما بتنعدل من هون — عدّلها بـ hjz وبعدين حدّث.",
          )}
          footer={
            canEdit ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {syncEnabled ? (
                  <>
                    <button type="button" className="btn ghost" onClick={onSync} disabled={syncMut.loading || syncToggleMut.loading}>
                      {syncMut.loading
                        ? tx("Re-syncing…", "جارٍ التحديث…")
                        : tx("Re-sync services from hjz", "حدّث الخدمات من hjz")}
                    </button>
                    {!confirmSyncOff && (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => setConfirmSyncOff(true)}
                        disabled={syncMut.loading || syncToggleMut.loading}
                      >
                        {tx("Turn sync off", "وقّف التزامن")}
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" className="btn primary" onClick={onSyncOn} disabled={syncToggleMut.loading}>
                    {syncToggleMut.loading ? tx("Turning on…", "جارٍ التشغيل…") : tx("Turn sync on", "شغّل التزامن")}
                  </button>
                )}
              </div>
            ) : null
          }
        >
          {/* The state line: is the catalogue reaching the AI right now? */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              background: "var(--bg-2)",
              borderRadius: 10,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                flexShrink: 0,
                background: syncEnabled ? "var(--ok)" : "var(--ink-3)",
              }}
            />
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500 }}>
              {syncEnabled
                ? tx("Sync is on — the AI uses your hjz services, branches and staff.", "التزامن شغّال — الذكاء الاصطناعي بيستخدم خدماتك وفروعك وطاقمك من hjz.")
                : tx("Sync is off — the AI is not using any hjz data.", "التزامن متوقف — الذكاء الاصطناعي ما بيستخدم أي بيانات من hjz.")}
            </div>
            <Badge kind={syncEnabled ? "ok" : ""}>
              {syncEnabled ? tx("On", "شغّال") : tx("Off", "متوقف")}
            </Badge>
          </div>

          {/* Turning sync off removes data, so it confirms inline — same
              pattern as doc deletion: say exactly what will happen. */}
          {canEdit && syncEnabled && confirmSyncOff && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 14px",
                background: "var(--bg-2)",
                border: "1px solid var(--bad)",
                borderRadius: 10,
              }}
            >
              <div style={{ flex: 1, fontSize: 12, lineHeight: 1.6 }}>
                {tx(
                  `This removes the ${syncedDocs.length || ""} synced document${syncedDocs.length === 1 ? "" : "s"} (services, branches, staff) and the AI stops using hjz data until you turn sync back on and re-sync. Your own written knowledge stays.`,
                  `هيك بننحذف المستندات المسحوبة (الخدمات والفروع والطاقم) وبيوقف الذكاء الاصطناعي عن استخدام بيانات hjz لحد ما ترجّع التزامن وتحدّث. معلوماتك المكتوبة بإيدك بتظل.`,
                )}
              </div>
              <button type="button" className="btn ghost" onClick={() => setConfirmSyncOff(false)} disabled={syncToggleMut.loading}>
                {tx("Cancel", "إلغاء")}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={onSyncOff}
                disabled={syncToggleMut.loading}
                style={{ background: "var(--bad)", borderColor: "var(--bad)" }}
              >
                {syncToggleMut.loading ? tx("Turning off…", "جارٍ الإيقاف…") : tx("Turn off and remove", "وقّفه واحذف")}
              </button>
            </div>
          )}

          {syncedDocs.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              {syncEnabled
                ? tx(
                    "Nothing synced yet. Press re-sync to pull your services, branches and staff.",
                    "ما في شي محدّث لهلأ. اضغط تحديث لسحب الخدمات والفروع والطاقم.",
                  )
                : tx(
                    "No synced documents — sync is off.",
                    "ما في مستندات مسحوبة — التزامن متوقف.",
                  )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {syncedDocs.map((d) => (
                <DocRow key={d.id} tx={tx} doc={d} canEdit={false} onView={() => setViewing(d)} />
              ))}
            </div>
          )}
          {syncMut.loading && (
            <div className="mono muted pulse" style={{ fontSize: 12 }}>
              {tx(
                "Pulling from hjz and re-indexing — this can take a moment.",
                "عم نسحب من hjz ونعيد الفهرسة — بدها شوي وقت.",
              )}
            </div>
          )}
          {syncResult && (
            <div style={{ fontSize: 12, color: "var(--ok)" }}>✓ {syncResult}</div>
          )}
          <ErrorRow message={syncMut.error ?? syncToggleMut.error} />
        </SettingsCard>
      )}

      {pendingDelete && (
        <DeleteConfirm
          tx={tx}
          doc={pendingDelete}
          busy={deleteMut.loading}
          onCancel={() => setPendingDelete(null)}
          onConfirm={onConfirmDelete}
        />
      )}

      <StatusToast message={status} />
    </>
  );
}

/* ─── The assistant's on/off switch ──────────────────────────────────────────
 *
 * The owner's real question on opening this tab is "is my bot talking to my
 * customers right now?", and until this card existed the only answer was in a
 * database. Two independent controls, kept visibly separate because conflating
 * them is the expensive mistake:
 *
 *   ON/OFF  — the emergency stop. Off = the agent never runs, nothing is spent.
 *   DELIVERY — sent automatically, or written as a draft for review. Drafting
 *              still runs the model and still costs money.
 *
 * The OFF copy leads with "messages still arrive", because the fear that stops
 * an owner from ever touching this switch is losing a customer while it's off.
 */
function AiAssistantCard({
  tx,
  canEdit,
  showStatus,
}: {
  tx: Tx;
  canEdit: boolean;
  showStatus: (msg: string) => void;
}) {
  const settingsQ = useFetch<AiSettings>("/ai/settings");
  const s = settingsQ.data;

  // Open only while turning OFF: the reason is what upstream demands, and it is
  // the record of why the bot was silenced. Turning it back on needs nothing.
  const [reason, setReason] = useState<string | null>(null);

  const toggleMut = useMutation<{ enabled: boolean; reason?: string }, ToggleResult>((i) =>
    setAiEnabled(i.enabled, i.reason),
  );
  const modeMut = useMutation<AutonomyMode, AiSettings>((m) => setAutonomyMode(m));

  const onTurnOff = async () => {
    const text = (reason ?? "").trim();
    if (!text) return;
    await toggleMut.mutate({ enabled: false, reason: text });
    setReason(null);
    settingsQ.refetch();
    showStatus(
      tx(
        "The assistant is off. Messages still reach your team.",
        "المساعد صار مطفي. الرسائل بتوصل لفريقك عادي.",
      ),
    );
  };

  const onTurnOn = async () => {
    await toggleMut.mutate({ enabled: true });
    settingsQ.refetch();
    showStatus(tx("The assistant is answering again.", "المساعد رجع يرد."));
  };

  const onChangeMode = async (mode: AutonomyMode) => {
    if (!s || mode === s.autonomyMode) return;
    await modeMut.mutate(mode);
    settingsQ.refetch();
    showStatus(
      mode === "AUTONOMOUS"
        ? tx("Replies now go out automatically.", "صار بيبعت الردود تلقائياً.")
        : tx("The assistant will write drafts for review.", "صار بيكتب مسودات لتراجعها."),
    );
  };

  if (!s) {
    return (
      <SettingsCard title={tx("AI assistant", "المساعد الذكي")}>
        {settingsQ.error ? (
          <ErrorRow message={settingsQ.error} />
        ) : (
          <div className="mono muted pulse" style={{ fontSize: 12 }}>
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}
      </SettingsCard>
    );
  }

  const busy = toggleMut.loading || modeMut.loading;
  const on = s.aiEnabled;
  const drafting = s.autonomyMode === "SHADOW";

  // One sentence, no jargon: what is happening to a customer messaging RIGHT NOW.
  const statusLine = !on
    ? tx(
        "Not answering. Messages still arrive for your team.",
        "ما بيرد. الرسائل بتوصل لفريقك عادي.",
      )
    : drafting
      ? tx("Writing drafts only — nothing is sent.", "بيكتب مسودات بس — ما بينبعت شي.")
      : tx("Answering customers on WhatsApp", "عم يرد على العملاء بواتساب");

  return (
    <SettingsCard
      title={tx("AI assistant", "المساعد الذكي")}
      description={
        s.personaName
          ? tx(`Your assistant is called ${s.personaName}.`, `اسم مساعدتك ${s.personaName}.`)
          : undefined
      }
      footer={
        canEdit ? (
          on ? (
            // Not a switch that flips instantly: turning it off is the one
            // action here with a customer-visible consequence, so it opens the
            // reason box and commits only after that is filled in.
            reason === null ? (
              <button type="button" className="btn ghost" onClick={() => setReason("")} disabled={busy}>
                {tx("Turn off", "طفّيه")}
              </button>
            ) : null
          ) : (
            <button type="button" className="btn primary" onClick={onTurnOn} disabled={busy}>
              {busy ? tx("Turning on…", "جارٍ التشغيل…") : tx("Turn on", "شغّله")}
            </button>
          )
        ) : null
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          background: "var(--bg-2)",
          borderRadius: 10,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            flexShrink: 0,
            background: !on ? "var(--ink-3)" : drafting ? "var(--warn)" : "var(--ok)",
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{statusLine}</div>
          {!on && (
            <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.6 }}>
              {tx(
                "Nothing is lost while it's off — every message still lands in your inbox.",
                "ما بيضيع إشي وهو مطفي — كل رسالة بتوصل لصندوق الوارد.",
              )}
            </div>
          )}
        </div>
        <Badge kind={!on ? "" : drafting ? "warn" : "ok"}>
          {on ? tx("On", "شغّال") : tx("Off", "مطفي")}
        </Badge>
      </div>

      {/* The reason box, only while turning off. */}
      {canEdit && on && reason !== null && (
        <div style={{ display: "grid", gap: 8 }}>
          <Field
            label={tx("Why are you turning it off?", "ليش عم تطفيه؟")}
            hint={tx(
              "This is the record of why the assistant was silenced — whoever finds it off later will know whether to turn it back on.",
              "هذا سجل ليش انطفى المساعد — اللي بيلاقيه مطفي بعدين بيعرف إذا لازم يرجّعه.",
            )}
          >
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={tx("Giving wrong prices", "عم يعطي أسعار غلط")}
              maxLength={REASON_MAX}
              autoFocus
              style={inputStyle}
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setReason(null)}
              disabled={busy}
            >
              {tx("Cancel", "إلغاء")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={onTurnOff}
              disabled={busy || reason.trim().length === 0}
              style={{ background: "var(--bad)", borderColor: "var(--bad)" }}
            >
              {busy ? tx("Turning off…", "جارٍ الإطفاء…") : tx("Turn off", "طفّيه")}
            </button>
          </div>
        </div>
      )}

      {/* Delivery mode. Shown while off too — so the owner can see what will
          happen when they turn it back on — but only actionable while on. */}
      <Field
        label={tx("When a customer messages", "لما يبعت الزبون رسالة")}
        hint={
          drafting
            ? tx(
                "Drafts appear in the conversation for someone to send. The assistant still reads and thinks about every message.",
                "المسودات بتظهر بالمحادثة وحدا من فريقك بيبعتها. المساعد بيضل يقرأ ويفكر بكل رسالة.",
              )
            : tx(
                "The assistant replies on its own, without waiting for anyone.",
                "المساعد بيرد لحاله، بدون ما يستنى حدا.",
              )
        }
      >
        <select
          value={s.autonomyMode}
          onChange={(e) => void onChangeMode(e.target.value as AutonomyMode)}
          disabled={!canEdit || busy || !on}
          style={{ ...inputStyle, opacity: canEdit && on ? 1 : 0.6 }}
        >
          {AUTONOMY_MODES.map((m) => (
            <option key={m} value={m}>
              {m === "AUTONOMOUS"
                ? tx("Send replies automatically", "ابعت الردود تلقائياً")
                : tx("Write drafts for review", "اكتب مسودات للمراجعة")}
            </option>
          ))}
        </select>
      </Field>

      {!canEdit && (
        <div className="muted" style={{ fontSize: 11 }}>
          {tx(
            "Only an owner or admin can turn the assistant on or off.",
            "بس صاحب الحساب أو الأدمن بيقدر يشغّل أو يطفي المساعد.",
          )}
        </div>
      )}

      <ErrorRow message={toggleMut.error ?? modeMut.error} />
    </SettingsCard>
  );
}

/* ─── List row ────────────────────────────────────────────────────────── */

/* ─── Read-only viewer ───────────────────────────────────────────────────────
 *
 * The exact text the AI retrieves, shown verbatim. When the assistant answers a
 * customer wrongly, the first question is always "what does it actually know?"
 * — without this the owner can only see a title and has to guess.
 *
 * whiteSpace: pre-wrap because the synced docs are newline-separated lists;
 * collapsing them would misrepresent what is stored.
 */
function ViewCard({ tx, doc, onClose }: { tx: Tx; doc: AiKnowledgeDoc; onClose: () => void }) {
  const label = syncedLabel(doc.title) ?? KIND_LABELS[doc.kind] ?? KIND_LABELS.OTHER;
  return (
    <SettingsCard
      title={displayTitle(doc.title, tx)}
      description={tx(
        `${tx(label.en, label.ar)} · ${doc.body.length.toLocaleString()} chars · this is exactly what the AI reads`,
        `${tx(label.en, label.ar)} · ${doc.body.length.toLocaleString()} حرف · هذا بالضبط اللي بيقرأه الذكاء الاصطناعي`,
      )}
      footer={
        <button type="button" className="btn ghost" onClick={onClose}>
          {tx("Close", "إغلاق")}
        </button>
      }
    >
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 13,
          lineHeight: 1.8,
          background: "var(--bg-2)",
          borderRadius: 10,
          padding: "12px 14px",
          maxHeight: 420,
          overflowY: "auto",
        }}
      >
        {doc.body}
      </div>
    </SettingsCard>
  );
}

function DocRow({
  tx,
  doc,
  canEdit,
  onView,
  onEdit,
  onDelete,
}: {
  tx: Tx;
  doc: AiKnowledgeDoc;
  canEdit: boolean;
  onView?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const label = KIND_LABELS[doc.kind] ?? KIND_LABELS.OTHER;
  // A synced doc's real subject is in its title, not its kind — all three come
  // back as SERVICE_DESCRIPTION. Prefer the specific label so "Team" isn't
  // badged "Service".
  const shown = syncedLabel(doc.title) ?? label;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        background: "var(--bg-2)",
        borderRadius: 10,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={displayTitle(doc.title, tx)}
          >
            {displayTitle(doc.title, tx)}
          </span>
          <Badge kind={KIND_BADGE[doc.kind] ?? ""}>{tx(shown.en, shown.ar)}</Badge>
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
          {tx(
            `${doc.body.length.toLocaleString()} chars · updated ${formatWhen(doc.updatedAt, tx)}`,
            `${doc.body.length.toLocaleString()} حرف · آخر تحديث ${formatWhen(doc.updatedAt, tx)}`,
          )}
        </div>
      </div>
      {onView && (
        <button type="button" className="btn ghost sm" onClick={onView}>
          {tx("View", "عرض")}
        </button>
      )}
      {canEdit && onEdit && (
        <button type="button" className="btn ghost sm" onClick={onEdit}>
          {tx("Edit", "تعديل")}
        </button>
      )}
      {canEdit && onDelete && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={onDelete}
          style={{ color: "var(--bad)" }}
        >
          {tx("Delete", "حذف")}
        </button>
      )}
    </div>
  );
}

/* ─── Empty state ─────────────────────────────────────────────────────── */

/** Not "no data" — an explanation of what this screen is for, with examples
 *  drawn from what the agent currently CANNOT answer. */
function EmptyState({ tx }: { tx: Tx }) {
  const examples = [
    { en: "Cancellation policy — how much notice you need", ar: "سياسة الإلغاء — قديش بدك إشعار مسبق" },
    { en: "Parking — where customers can park", ar: "المواقف — وين بيركنوا الزباين" },
    { en: "Are kids welcome?", ar: "بتستقبلوا أطفال؟" },
  ];
  return (
    <div style={{ padding: "8px 4px", lineHeight: 1.8 }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
        {tx(
          "The AI only knows your services, branches and staff so far.",
          "لهلأ الذكاء الاصطناعي بس بيعرف خدماتك وفروعك وطاقمك.",
        )}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {tx(
          "Ask it anything else and it has nothing to go on. Add what your customers actually ask about:",
          "أي شي غير هيك بيسأله الزبون، ما عنده جواب. ضيف الأشياء اللي الزباين بيسألوا عنها فعلاً:",
        )}
      </div>
      <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12, color: "var(--ink-2)" }}>
        {examples.map((e) => (
          <li key={e.en} style={{ marginBottom: 3 }}>
            {tx(e.en, e.ar)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─── Editor ──────────────────────────────────────────────────────────── */

function DraftEditor({
  tx,
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  error,
  fileNote,
  setFileNote,
}: {
  tx: Tx;
  draft: DraftState;
  setDraft: (d: DraftState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  fileNote: { kind: "ok" | "bad"; text: string } | null;
  setFileNote: (n: { kind: "ok" | "bad"; text: string } | null) => void;
}) {
  const len = draft.body.length;
  const overCap = len > BODY_MAX;
  // Warn before the wall, not at it: an owner pasting a long price list should
  // see the counter change colour with room left to trim.
  const nearCap = len > BODY_MAX * 0.9;
  const titleTooLong = draft.title.trim().length > TITLE_MAX;
  const canSave =
    draft.title.trim().length > 0 && draft.body.trim().length > 0 && !overCap && !titleTooLong;

  return (
    <SettingsCard
      title={draft.id ? tx("Edit knowledge", "تعديل المعلومة") : tx("Add knowledge", "أضف معلومة")}
      description={
        draft.sourceFilename
          ? tx(
              `From ${draft.sourceFilename} — review it below, then save. Nothing is sent to the AI until you do.`,
              `من ملف ${draft.sourceFilename} — راجع النص تحت وبعدين احفظ. ما بينحفظ شي قبل ما تضغط حفظ.`,
            )
          : tx(
              "Write it the way you'd explain it to a new employee.",
              "اكتبها متل ما بتشرحها لموظفة جديدة.",
            )
      }
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" onClick={onSave} disabled={saving || !canSave}>
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
          </button>
        </>
      }
    >
      {fileNote && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 12,
            background: fileNote.kind === "ok" ? "var(--bg-2)" : "oklch(0.7 0.22 24 / 0.12)",
            color: fileNote.kind === "ok" ? "var(--ink-2)" : "var(--bad)",
          }}
        >
          {fileNote.text}
        </div>
      )}

      <Field label={tx("Title", "العنوان")}>
        <input
          type="text"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder={tx("Cancellation policy", "سياسة الإلغاء")}
          maxLength={TITLE_MAX}
          style={inputStyle}
        />
      </Field>

      <Field
        label={tx("Type", "النوع")}
        hint={tx(
          "Helps the assistant judge how to use it.",
          "بيساعد المساعد يعرف كيف يستخدم المعلومة.",
        )}
      >
        <select
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as KnowledgeKind })}
          style={inputStyle}
        >
          {KNOWLEDGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {tx(KIND_LABELS[k].en, KIND_LABELS[k].ar)}
            </option>
          ))}
        </select>
      </Field>

      <Field label={tx("What should the AI know?", "شو لازم يعرف الذكاء الاصطناعي؟")}>
        <textarea
          value={draft.body}
          onChange={(e) => {
            setDraft({ ...draft, body: e.target.value });
            if (fileNote) setFileNote(null);
          }}
          rows={12}
          placeholder={tx(
            "Cancelling less than 24 hours before the appointment costs half the service price.",
            "الإلغاء قبل أقل من ٢٤ ساعة من الموعد بيكلف نص سعر الخدمة.",
          )}
          style={{
            ...inputStyle,
            height: "auto",
            minHeight: 220,
            padding: 12,
            lineHeight: 1.7,
            resize: "vertical",
            borderColor: overCap ? "var(--bad)" : "var(--line)",
          }}
        />
      </Field>

      <div
        className="mono"
        style={{
          fontSize: 11,
          textAlign: "end",
          color: overCap ? "var(--bad)" : nearCap ? "var(--warn)" : "var(--ink-3)",
          fontWeight: nearCap ? 600 : 400,
        }}
      >
        {len.toLocaleString()} / {BODY_MAX.toLocaleString()}
        {overCap &&
          ` — ${tx(
            `${(len - BODY_MAX).toLocaleString()} over the limit`,
            `زيادة ${(len - BODY_MAX).toLocaleString()} حرف عن الحد`,
          )}`}
      </div>

      <ErrorRow message={error} />
    </SettingsCard>
  );
}

/* ─── File upload ─────────────────────────────────────────────────────── */

/**
 * Parses a .txt/.md file in the BROWSER and prefills the editor with the text.
 * It is never saved automatically — the owner must read it and press Save,
 * because an unreviewed document becomes something the AI states to customers
 * as fact.
 */
function FileDropCard({
  tx,
  onExtracted,
  setFileNote,
  fileNote,
}: {
  tx: Tx;
  onExtracted: (d: DraftState) => void;
  setFileNote: (n: { kind: "ok" | "bad"; text: string } | null) => void;
  fileNote: { kind: "ok" | "bad"; text: string } | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      setFileNote({
        kind: "bad",
        text: tx(
          `${file.name} isn't a .txt or .md file. PDF and Word aren't supported yet — copy the text in by hand for now.`,
          `${file.name} مش ملف .txt أو .md. الـPDF وWord لسا مش مدعومين — انسخ النص يدوياً هلأ.`,
        ),
      });
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileNote({
        kind: "bad",
        text: tx("Couldn't read that file.", "ما قدرنا نقرأ هالملف."),
      });
      return;
    }

    // Say so plainly rather than opening an editor onto an empty box: a file
    // that looked fine on disk but yielded nothing is the confusing case.
    if (text.trim().length === 0) {
      setFileNote({
        kind: "bad",
        text: tx(
          `${file.name} has no readable text in it — nothing to teach the AI.`,
          `${file.name} ما فيه نص مقروء — ما في شي نعلّمه للذكاء الاصطناعي.`,
        ),
      });
      return;
    }

    const truncated = text.length > BODY_MAX;
    const body = truncated ? text.slice(0, BODY_MAX) : text;
    // Filename minus extension is a better first guess at a title than blank.
    const title = file.name.replace(/\.(txt|md)$/i, "").slice(0, TITLE_MAX);

    setFileNote({
      kind: "ok",
      text: truncated
        ? tx(
            `Read ${text.length.toLocaleString()} characters from ${file.name}, trimmed to the ${BODY_MAX.toLocaleString()} limit. Review before saving.`,
            `قرأنا ${text.length.toLocaleString()} حرف من ${file.name}، وقصّيناها للحد ${BODY_MAX.toLocaleString()}. راجعها قبل الحفظ.`,
          )
        : tx(
            `Read ${text.length.toLocaleString()} characters from ${file.name}. Review before saving.`,
            `قرأنا ${text.length.toLocaleString()} حرف من ${file.name}. راجعها قبل الحفظ.`,
          ),
    });
    onExtracted({ title, kind: "OTHER", body, sourceFilename: file.name });
  };

  return (
    <SettingsCard
      title={tx("Upload a document", "ارفع ملف")}
      description={tx(
        "Drop a .txt or .md file and we'll fill the editor with its text for you to review. Nothing reaches the AI until you save.",
        "أسقط ملف .txt أو .md ومنعبّي المحرر بنصه لتراجعه. ما بيوصل شي للذكاء الاصطناعي قبل ما تحفظ.",
      )}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `1.5px dashed ${dragging ? "var(--accent)" : "var(--line)"}`,
          background: dragging ? "var(--bg-2)" : "transparent",
          borderRadius: 10,
          padding: "22px 16px",
          textAlign: "center",
          cursor: "pointer",
          transition: "border-color .12s, background .12s",
        }}
      >
        <div style={{ fontSize: 13, marginBottom: 4 }}>
          {tx("Drop a file here, or click to choose", "أسقط ملف هون، أو اضغط لتختار")}
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>
          .txt · .md
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.md,text/plain,text/markdown"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Reset so re-picking the same file fires change again.
            e.target.value = "";
          }}
        />
      </div>
      {fileNote && fileNote.kind === "bad" && <ErrorRow message={fileNote.text} />}
    </SettingsCard>
  );
}

/* ─── Delete confirmation ─────────────────────────────────────────────── */

function DeleteConfirm({
  tx,
  doc,
  busy,
  onCancel,
  onConfirm,
}: {
  tx: Tx;
  doc: AiKnowledgeDoc;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "grid",
        placeItems: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          padding: 24,
          width: 440,
          maxWidth: "90vw",
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
          {tx("Delete this knowledge?", "حذف هالمعلومة؟")}
        </h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.7 }}>
          {tx(
            `The AI will immediately stop using "${doc.title}" when answering customers. This can't be undone — you'd have to write it again.`,
            `الذكاء الاصطناعي رح يبطّل يستخدم "${doc.title}" فوراً لما يرد على الزباين. ما في رجعة — بدك تكتبها من جديد.`,
          )}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            {tx("Keep it", "خليها")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={onConfirm}
            disabled={busy}
            style={{ background: "var(--bad)", borderColor: "var(--bad)" }}
          >
            {busy ? tx("Deleting…", "جارٍ الحذف…") : tx("Delete", "احذف")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────────── */

function formatWhen(iso: string, tx: Tx): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return tx("just now", "هلأ");
  if (mins < 60) return tx(`${mins}m ago`, `قبل ${mins} دقيقة`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tx(`${hours}h ago`, `قبل ${hours} ساعة`);
  const days = Math.floor(hours / 24);
  if (days < 30) return tx(`${days}d ago`, `قبل ${days} يوم`);
  return new Date(iso).toLocaleDateString();
}

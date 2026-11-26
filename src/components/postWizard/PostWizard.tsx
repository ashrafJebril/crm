import { useEffect, useMemo, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import { api } from "@/api/client";
import { uploadMedia } from "@/api/uploadMedia";
import { mediaErrorText } from "@/components/media/mediaErrors";
import { SchedulePicker } from "@/components/SchedulePicker";
import { IconBolt, IconCheck, IconPlus, IconX } from "@/icons";
import type { Media } from "@/lib/types";
import { capability, mediaLimits, visibleOptions, type OptionKey, type Platform, type PostKind } from "./capabilities";
import { STEPS, blockedReason, emptyState, publishBody, retarget, type Step, type WizardState } from "./wizardState";

interface ZernioStatus {
  accounts?: { platform: string; name?: string | null }[];
}

/**
 * The social post wizard: Type → Media → Details → Preview → Share.
 *
 * One wizard for both platforms, because the Instagram and Facebook specs
 * describe the same six steps. The Details step is the only platform-aware
 * part, and it is driven entirely by `capabilities.ts` — so a field appears
 * only where Zernio's schema says it does something.
 *
 * The Edit/Design step (crop, trim, filters, text) is deliberately absent:
 * it is a media editor, independent of publishing, and was deferred so the
 * rest could ship.
 */
export function PostWizard({
  open,
  onClose,
  onPosted,
}: {
  open: boolean;
  onClose: () => void;
  onPosted?: () => void;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const statusQ = useFetch<ZernioStatus>(open ? "/integrations/zernio/status" : null);
  const mediaQ = useFetch<Media[]>(open ? "/media" : null);

  const [step, setStep] = useState<Step>("type");
  const [state, setState] = useState<WizardState>(() => emptyState());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep("type");
      setState(emptyState());
      setError(null);
      setDone(false);
    }
  }, [open]);

  const connected = (p: string) => statusQ.data?.accounts?.some((a) => a.platform === p) ?? false;
  const accountName = (p: string) =>
    statusQ.data?.accounts?.find((a) => a.platform === p)?.name ?? p;

  const media = useMemo(
    () => state.mediaIds.map((id) => mediaQ.data?.find((m) => m.id === id)).filter(Boolean) as Media[],
    [state.mediaIds, mediaQ.data],
  );
  const blocked = blockedReason(state, step, tx);
  const limits = mediaLimits(state.platform, state.kind);

  const go = (dir: 1 | -1) => {
    const i = STEPS.indexOf(step) + dir;
    if (i >= 0 && i < STEPS.length) setStep(STEPS[i]);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/social/publish", publishBody(state));
      setDone(true);
      onPosted?.();
    } catch (e) {
      setError((e as { message?: string })?.message ?? tx("Publishing failed.", "فشل النشر."));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--scrim, rgba(0,0,0,0.55))", zIndex: 80 }} />
      <div
        role="dialog"
        aria-label={tx("New post", "منشور جديد")}
        className="dialog"
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "min(880px, 96vw)", height: "min(720px, 92vh)",
          background: "var(--bg-elev)", border: "1px solid var(--line-soft)",
          borderRadius: 14, boxShadow: "var(--shadow-lg)", zIndex: 81,
          display: "flex", flexDirection: "column",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line-soft)" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{tx("New post", "منشور جديد")}</span>
          <StepTrail step={step} state={state} tx={tx} onJump={setStep} />
          <button type="button" className="btn ghost icon sm" onClick={onClose} aria-label={tx("Close", "إغلاق")}>
            <IconX w={14} />
          </button>
        </header>

        <div style={{ flex: 1, overflow: "auto", padding: 18 }}>
          {done ? (
            <Done tx={tx} scheduled={!!state.scheduledFor} draft={state.asDraft} onClose={onClose} />
          ) : step === "type" ? (
            <TypeStep state={state} setState={setState} tx={tx} connected={connected} accountName={accountName} />
          ) : step === "media" ? (
            <MediaStep state={state} setState={setState} tx={tx} media={media} mediaQ={mediaQ} limits={limits} />
          ) : step === "details" ? (
            <DetailsStep state={state} setState={setState} tx={tx} media={media} />
          ) : step === "preview" ? (
            <PreviewStep state={state} media={media} tx={tx} accountName={accountName} />
          ) : (
            <ShareStep state={state} setState={setState} tx={tx} />
          )}
        </div>

        {!done && (
          <footer style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderTop: "1px solid var(--line-soft)", flexWrap: "wrap" }}>
            {blocked && <span style={{ fontSize: 12, color: "var(--warn)" }}>{blocked}</span>}
            {error && <span style={{ fontSize: 12, color: "var(--bad)" }}>{error}</span>}
            <span style={{ flex: 1 }} />
            {step !== "type" && (
              <button type="button" className="btn" onClick={() => go(-1)} disabled={busy}>
                {tx("Back", "رجوع")}
              </button>
            )}
            {step !== "share" ? (
              <button type="button" className="btn primary" onClick={() => go(1)} disabled={!!blocked}>
                {tx("Next", "التالي")}
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>
                <IconBolt w={13} />
                {busy
                  ? tx("Working…", "جارٍ التنفيذ…")
                  : state.asDraft
                    ? tx("Save draft", "حفظ كمسودة")
                    : state.scheduledFor
                      ? tx("Schedule", "جدولة")
                      : tx("Post now", "انشر الآن")}
              </button>
            )}
          </footer>
        )}
      </div>
    </>
  );
}

/* ── Step trail ──────────────────────────────────────────────────────── */

function StepTrail({
  step, state, tx, onJump,
}: { step: Step; state: WizardState; tx: Tx; onJump: (s: Step) => void }) {
  const labels: Record<Step, string> = {
    type: tx("Type", "النوع"),
    media: tx("Media", "الملفات"),
    details: tx("Details", "التفاصيل"),
    preview: tx("Preview", "معاينة"),
    share: tx("Share", "النشر"),
  };
  const current = STEPS.indexOf(step);
  return (
    <nav style={{ display: "flex", gap: 4, flex: 1, justifyContent: "center", flexWrap: "wrap" }}>
      {STEPS.map((s, i) => {
        const reachable = i <= current || !blockedReason(state, STEPS[i - 1] ?? "type", tx);
        return (
          <button
            key={s}
            type="button"
            disabled={!reachable}
            onClick={() => reachable && onJump(s)}
            style={{
              background: "none", border: "none", padding: "3px 8px", borderRadius: 999,
              fontSize: 11.5, cursor: reachable ? "pointer" : "default",
              color: i === current ? "var(--accent)" : "var(--ink-3)",
              fontWeight: i === current ? 600 : 400,
              opacity: reachable ? 1 : 0.45,
            }}
          >
            {i + 1}. {labels[s]}
          </button>
        );
      })}
    </nav>
  );
}

type Tx = (en: string, ar: string) => string;

/* ── 1. Type ─────────────────────────────────────────────────────────── */

function TypeStep({
  state, setState, tx, connected, accountName,
}: {
  state: WizardState; setState: (s: WizardState) => void; tx: Tx;
  connected: (p: string) => boolean; accountName: (p: string) => string;
}) {
  const kinds: { key: PostKind; en: string; ar: string; hint: [string, string] }[] = [
    { key: "post", en: "Post", ar: "منشور", hint: ["Photo, video, or a carousel", "صورة أو فيديو أو كاروسيل"] },
    { key: "reel", en: "Reel", ar: "ريل", hint: ["One vertical video", "فيديو عمودي واحد"] },
    { key: "story", en: "Story", ar: "ستوري", hint: ["Disappears after 24 hours", "يختفي بعد ٢٤ ساعة"] },
  ];
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <Field label={tx("Post to", "انشر على")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["instagram", "facebook"] as Platform[]).map((p) => (
            <Choice
              key={p}
              active={state.platform === p}
              disabled={!connected(p)}
              onClick={() => setState(retarget(state, { platform: p }))}
              title={p === "instagram" ? "Instagram" : "Facebook"}
              sub={connected(p) ? accountName(p) : tx("Not connected", "غير مرتبط")}
            />
          ))}
        </div>
      </Field>

      <Field label={tx("Type", "النوع")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {kinds.map((k) => (
            <Choice
              key={k.key}
              active={state.kind === k.key}
              onClick={() => setState(retarget(state, { kind: k.key }))}
              title={tx(k.en, k.ar)}
              sub={tx(k.hint[0], k.hint[1])}
            />
          ))}
        </div>
      </Field>

      <Note tx={tx}>
        {tx(
          `${state.platform === "instagram" ? "Instagram" : "Facebook"} ${state.kind} supports ${visibleOptions(state.platform, state.kind).length} options. Changing type drops anything the new type can't do.`,
          `${state.kind} على ${state.platform === "instagram" ? "إنستغرام" : "فيسبوك"} يدعم ${visibleOptions(state.platform, state.kind).length} خياراً. تغيير النوع يحذف ما لا يدعمه النوع الجديد.`,
        )}
      </Note>
    </div>
  );
}

/* ── 2. Media ────────────────────────────────────────────────────────── */

function MediaStep({
  state, setState, tx, media, mediaQ, limits,
}: {
  state: WizardState; setState: (s: WizardState) => void; tx: Tx;
  media: Media[]; mediaQ: { data: Media[] | null; refetch: () => Promise<void> };
  limits: { min: number; max: number };
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState<string | null>(null);

  const add = (id: string) => {
    if (state.mediaIds.includes(id) || state.mediaIds.length >= limits.max) return;
    setState({ ...state, mediaIds: [...state.mediaIds, id] });
  };
  const remove = (id: string) =>
    setState({ ...state, mediaIds: state.mediaIds.filter((m) => m !== id) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= state.mediaIds.length) return;
    const next = [...state.mediaIds];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    setState({ ...state, mediaIds: next });
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setUpErr(null);
    try {
      const room = limits.max - state.mediaIds.length;
      const picked = Array.from(files).slice(0, Math.max(room, 0));
      const added: string[] = [];
      for (const f of picked) added.push((await uploadMedia(f)).id);
      await mediaQ.refetch();
      setState({ ...state, mediaIds: [...state.mediaIds, ...added] });
    } catch (e) {
      setUpErr(mediaErrorText(e, tx));
    } finally {
      setUploading(false);
    }
  };

  const library = (mediaQ.data ?? []).filter((m) => !state.mediaIds.includes(m.id)).slice(0, 24);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <Field
        label={tx("Selected", "المحدد")}
        hint={tx(
          limits.max === 1 ? "One item." : `Up to ${limits.max}. Order is the order they appear.`,
          limits.max === 1 ? "عنصر واحد." : `حتى ${limits.max}. الترتيب هو ترتيب الظهور.`,
        )}
      >
        {media.length === 0 ? (
          <Empty tx={tx}>{tx("Nothing selected yet.", "لم يتم اختيار شيء.")}</Empty>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {media.map((m, i) => (
              <div key={m.id} style={{ position: "relative", width: 96 }}>
                <Thumb media={m} />
                <div style={{ display: "flex", gap: 2, marginBlockStart: 4 }}>
                  <button type="button" className="btn ghost sm" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={tx("Move earlier", "تقديم")}>‹</button>
                  <span style={{ flex: 1, textAlign: "center", fontSize: 11, color: "var(--ink-3)" }}>{i + 1}</span>
                  <button type="button" className="btn ghost sm" onClick={() => move(i, i + 1)} disabled={i === media.length - 1} aria-label={tx("Move later", "تأخير")}>›</button>
                  <button type="button" className="btn ghost sm" onClick={() => remove(m.id)} aria-label={tx("Remove", "إزالة")}><IconX w={11} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Field>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={uploading || state.mediaIds.length >= limits.max}>
          <IconPlus w={12} /> {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload", "رفع")}
        </button>
        <input ref={fileRef} type="file" multiple={limits.max > 1} accept="image/*,video/*" hidden onChange={(e) => void onFiles(e.target.files)} />
      </div>
      {upErr && <span style={{ fontSize: 12, color: "var(--bad)" }}>{upErr}</span>}

      <Field label={tx("From library", "من المكتبة")}>
        {library.length === 0 ? (
          <Empty tx={tx}>{tx("Library is empty.", "المكتبة فارغة.")}</Empty>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {library.map((m) => (
              <button key={m.id} type="button" onClick={() => add(m.id)} disabled={state.mediaIds.length >= limits.max}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }} aria-label={m.fileName}>
                <Thumb media={m} />
              </button>
            ))}
          </div>
        )}
      </Field>
    </div>
  );
}

function Thumb({ media }: { media: Media }) {
  const isVideo = media.mimeType?.startsWith("video");
  return (
    <div style={{ width: 96, height: 96, borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", display: "grid", placeItems: "center", overflow: "hidden", fontSize: 10, color: "var(--ink-3)" }}>
      {isVideo ? "▶ video" : media.fileName?.slice(0, 14)}
    </div>
  );
}

/* ── 3. Details ──────────────────────────────────────────────────────── */

function DetailsStep({
  state, setState, tx, media,
}: { state: WizardState; setState: (s: WizardState) => void; tx: Tx; media: Media[] }) {
  const options = visibleOptions(state.platform, state.kind);
  const set = (key: OptionKey, value: unknown) =>
    setState({ ...state, options: { ...state.options, [key]: value } });
  const captionOk = capability(state.platform, state.kind, "caption").supported;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {captionOk ? (
        <Field label={tx("Caption", "النص")} hint={tx("Hashtags go in the text.", "الهاشتاغ جزء من النص.")}>
          <textarea
            dir="auto"
            rows={5}
            value={state.content}
            onChange={(e) => setState({ ...state, content: e.target.value })}
            placeholder={tx("Write your post…", "اكتب منشورك…")}
            style={inputStyle}
          />
        </Field>
      ) : (
        <Note tx={tx}>{capability(state.platform, state.kind, "caption").reason}</Note>
      )}

      {options.map((key) => (
        <OptionField key={key} option={key} state={state} set={set} tx={tx} media={media} setState={setState} />
      ))}

      <Unavailable platform={state.platform} kind={state.kind} tx={tx} />
    </div>
  );
}

/** Renders one option. Kept dumb: capabilities decides IF, this decides HOW. */
function OptionField({
  option, state, set, tx, media, setState,
}: {
  option: OptionKey; state: WizardState; set: (k: OptionKey, v: unknown) => void;
  tx: Tx; media: Media[]; setState: (s: WizardState) => void;
}) {
  const v = state.options[option];

  switch (option) {
    case "altText":
      return (
        <Field label={tx("Alt text", "النص البديل")} hint={tx("Images only. Describes the picture for screen readers.", "للصور فقط. يصف الصورة لقارئ الشاشة.")}>
          <div style={{ display: "grid", gap: 6 }}>
            {media.filter((m) => !m.mimeType?.startsWith("video")).map((m) => (
              <input key={m.id} dir="auto" placeholder={m.fileName} maxLength={1000}
                value={state.altTexts[m.id] ?? ""}
                onChange={(e) => setState({ ...state, altTexts: { ...state.altTexts, [m.id]: e.target.value } })}
                style={inputStyle} />
            ))}
            {media.every((m) => m.mimeType?.startsWith("video")) && (
              <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{tx("No images selected.", "لا توجد صور محددة.")}</span>
            )}
          </div>
        </Field>
      );

    case "location":
      return (
        <Field label={tx("Location", "الموقع")} hint={tx("A numeric Facebook Page ID — there is no place search.", "معرّف رقمي لصفحة فيسبوك — لا يوجد بحث عن الأماكن.")}>
          <input inputMode="numeric" value={(v as string) ?? ""} onChange={(e) => set("location", e.target.value.replace(/\D/g, ""))} placeholder="1058724220665775" style={inputStyle} />
        </Field>
      );

    case "tagPeople":
      return (
        <TagPeople state={state} set={set} tx={tx} />
      );

    case "collaborators":
      return (
        <Field
          label={tx("Collaborators", "متعاونون")}
          hint={state.platform === "facebook"
            ? tx("Numeric Page IDs, up to 10.", "معرّفات صفحات رقمية، حتى ١٠.")
            : tx("Instagram usernames, up to 3.", "أسماء مستخدمين، حتى ٣.")}
        >
          <CsvInput value={(v as string[]) ?? []} onChange={(list) => set("collaborators", list)} tx={tx} />
        </Field>
      );

    case "reelTitle":
      return (
        <Field label={tx("Reel title", "عنوان الريل")}>
          <input dir="auto" maxLength={255} value={(v as string) ?? ""} onChange={(e) => set("reelTitle", e.target.value)} style={inputStyle} />
        </Field>
      );

    case "aiLabel":
      return (
        <Toggle
          label={tx("Label as AI-generated", "وسمه كمحتوى مولّد بالذكاء الاصطناعي")}
          hint={state.platform === "facebook"
            ? tx("Facebook shows this on Reels and video Stories.", "يظهر على الريلز وستوري الفيديو.")
            : tx("For AI-generated media, not AI-written captions.", "للوسائط المولّدة، لا للنصوص.")}
          checked={v === true}
          onChange={(c) => set("aiLabel", c || undefined)}
          tx={tx}
        />
      );

    case "audioTrack":
      return <AudioPicker state={state} set={set} tx={tx} />;

    case "audioName":
      return (
        <Field label={tx("Name the audio", "اسم الصوت")} hint={tx("Replaces “Original audio”.", "يستبدل «الصوت الأصلي».")}>
          <input dir="auto" maxLength={100} value={(v as string) ?? ""} onChange={(e) => set("audioName", e.target.value)} style={inputStyle} />
        </Field>
      );

    case "cover":
      return (
        <Field label={tx("Cover image URL", "رابط صورة الغلاف")} hint={tx("Public HTTPS, 1080×1920 preferred.", "رابط عام، يفضّل ١٠٨٠×١٩٢٠.")}>
          <input type="url" dir="ltr" value={(v as string) ?? ""} onChange={(e) => set("cover", e.target.value)} placeholder="https://…" style={inputStyle} />
        </Field>
      );

    case "shareToFeed":
      return (
        <Toggle label={tx("Also show on my profile feed", "اعرضه أيضاً على الملف الشخصي")} hint={tx("Off keeps it in the Reels tab only.", "إيقافه يبقيه في تبويب الريلز فقط.")}
          checked={v !== false} onChange={(c) => set("shareToFeed", c ? undefined : false)} tx={tx} />
      );

    case "trialReel":
      return <TrialReel value={v as { graduationStrategy?: string } | undefined} set={set} tx={tx} />;

    case "subtitles":
      return (
        <Field label={tx("Subtitles (SRT or WebVTT)", "الترجمة (SRT أو WebVTT)")} hint={tx("Public URL per track, up to 200 KB each.", "رابط عام لكل مسار، حتى ٢٠٠ كيلوبايت.")}>
          <CsvInput value={(v as string[]) ?? []} onChange={(l) => set("subtitles", l)} tx={tx} placeholder="https://…/ar.srt" />
        </Field>
      );

    case "geoRestriction":
      return (
        <Field label={tx("Show only in these countries", "اعرضه في هذه الدول فقط")} hint={tx("Two-letter codes, up to 25. Leave empty for everywhere.", "رموز من حرفين، حتى ٢٥. اتركه فارغاً للجميع.")}>
          <CsvInput
            value={((v as { countries?: string[] })?.countries) ?? []}
            onChange={(l) => set("geoRestriction", l.length ? { countries: l.map((c) => c.toUpperCase()) } : undefined)}
            tx={tx}
            placeholder="JO, AE, SA"
          />
        </Field>
      );

    case "firstComment":
      return (
        <Field label={tx("First comment", "التعليق الأول")} hint={tx("Posted right after. Where links belong.", "يُنشر مباشرة بعده. مكان الروابط.")}>
          <textarea dir="auto" rows={2} value={(v as string) ?? ""} onChange={(e) => set("firstComment", e.target.value)} style={inputStyle} />
        </Field>
      );

    case "commentsOff":
      return (
        <Toggle label={tx("Turn off comments", "إيقاف التعليقات")} hint={tx("Applied just after publishing.", "يُطبّق بعد النشر مباشرة.")}
          checked={v === true} onChange={(c) => set("commentsOff", c || undefined)} tx={tx} />
      );

    default:
      return null;
  }
}

function TagPeople({ state, set, tx }: { state: WizardState; set: (k: OptionKey, v: unknown) => void; tx: Tx }) {
  const tags = (state.options.tagPeople as { username: string }[] | undefined) ?? [];
  const needsCoords = state.kind === "post";
  return (
    <Field
      label={tx("Tag people", "الإشارة إلى أشخاص")}
      hint={needsCoords
        ? tx("Photos need a position, so tags are placed at the centre.", "الصور تحتاج موضعاً، لذا تُوضع في المنتصف.")
        : tx("Usernames only.", "أسماء المستخدمين فقط.")}
    >
      <CsvInput
        value={tags.map((t) => t.username)}
        onChange={(list) =>
          set(
            "tagPeople",
            list.length
              ? list.map((u) => ({ username: u.replace(/^@/, ""), ...(needsCoords ? { x: 0.5, y: 0.5 } : {}) }))
              : undefined,
          )
        }
        tx={tx}
        placeholder="@username"
      />
    </Field>
  );
}

function TrialReel({ value, set, tx }: { value?: { graduationStrategy?: string }; set: (k: OptionKey, v: unknown) => void; tx: Tx }) {
  const on = !!value;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Toggle
        label={tx("Trial reel (non-followers only)", "ريل تجريبي (لغير المتابعين فقط)")}
        hint={tx("Test it before it reaches your followers.", "جرّبه قبل أن يصل متابعيك.")}
        checked={on}
        onChange={(c) => set("trialReel", c ? { graduationStrategy: "SS_PERFORMANCE" } : undefined)}
        tx={tx}
      />
      {on && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingInlineStart: 26 }}>
          {([
            ["SS_PERFORMANCE", tx("Share automatically if it does well", "انشره تلقائياً إذا نجح")],
            ["MANUAL", tx("I'll decide", "أنا أقرر")],
          ] as const).map(([k, label]) => (
            <Choice key={k} active={value?.graduationStrategy === k} onClick={() => set("trialReel", { graduationStrategy: k })} title={label} />
          ))}
        </div>
      )}
    </div>
  );
}

function AudioPicker({ state, set, tx }: { state: WizardState; set: (k: OptionKey, v: unknown) => void; tx: Tx }) {
  const [q, setQ] = useState("");
  const audioQ = useFetch<{ tracks: { audioId?: string; id?: string; title?: string; artist?: string }[]; unavailable: string | null }>(
    `/integrations/zernio/instagram/audio${q ? `?q=${encodeURIComponent(q)}` : ""}`,
  );
  const chosen = state.options.audioTrack as { audioId?: string } | undefined;

  if (audioQ.data?.unavailable) {
    return (
      <Note tx={tx} tone="warn">
        {tx(
          "Music needs this Instagram account connected with Facebook Login. Reconnect it in Channels to use the audio library.",
          "الموسيقى تتطلب ربط حساب إنستغرام عبر تسجيل دخول فيسبوك. أعد ربطه من صفحة القنوات.",
        )}
      </Note>
    );
  }

  return (
    <Field label={tx("Music", "الموسيقى")} hint={tx("Only tracks licensed for third-party publishing appear.", "تظهر المقاطع المرخّصة للنشر عبر طرف ثالث فقط.")}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx("Search, or leave blank for trending", "ابحث أو اتركه فارغاً للرائج")} style={inputStyle} />
      <div style={{ display: "grid", gap: 4, marginBlockStart: 8, maxHeight: 180, overflow: "auto" }}>
        {(audioQ.data?.tracks ?? []).slice(0, 20).map((t) => {
          const id = t.audioId ?? t.id ?? "";
          return (
            <button key={id} type="button" onClick={() => set("audioTrack", { audioId: id })}
              style={{ textAlign: "start", padding: "7px 10px", borderRadius: 8, cursor: "pointer",
                border: `1px solid ${chosen?.audioId === id ? "var(--accent-ring)" : "var(--line-soft)"}`,
                background: chosen?.audioId === id ? "var(--accent-soft)" : "var(--bg-2)" }}>
              <span style={{ fontSize: 13 }}>{t.title ?? id}</span>
              {t.artist && <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}> · {t.artist}</span>}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** What this platform and type can't do, and why — so the gap is explained. */
function Unavailable({ platform, kind, tx }: { platform: Platform; kind: PostKind; tx: Tx }) {
  const notable: OptionKey[] = ["location", "tagPeople", "commentsOff", "subtitles", "audioTrack", "poll"];
  const missing = notable
    .map((o) => ({ o, cap: capability(platform, kind, o) }))
    .filter((x) => !x.cap.supported && x.cap.reason);
  if (!missing.length) return null;
  return (
    <details style={{ fontSize: 12, color: "var(--ink-3)" }}>
      <summary style={{ cursor: "pointer" }}>{tx("Not available here", "غير متاح هنا")}</summary>
      <ul style={{ margin: "8px 0 0", paddingInlineStart: 18, display: "grid", gap: 4 }}>
        {missing.map((x) => <li key={x.o}>{x.cap.reason}</li>)}
      </ul>
    </details>
  );
}

/* ── 4. Preview ──────────────────────────────────────────────────────── */

function PreviewStep({ state, media, tx, accountName }: { state: WizardState; media: Media[]; tx: Tx; accountName: (p: string) => string }) {
  const vertical = state.kind !== "post";
  const captionOk = capability(state.platform, state.kind, "caption").supported;
  const text = state.content.trim();
  const short = text.length > 125 ? text.slice(0, 125) : text;

  return (
    <div style={{ display: "grid", placeItems: "center", gap: 12 }}>
      <div style={{ width: vertical ? 280 : 360, border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--bg-1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--accent-soft)" }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{accountName(state.platform)}</span>
        </div>
        <div style={{ aspectRatio: vertical ? "9 / 16" : "1 / 1", background: "var(--bg-3)", display: "grid", placeItems: "center", color: "var(--ink-4)", fontSize: 12 }}>
          {media.length ? tx(`${media.length} item(s)`, `${media.length} عنصر`) : tx("No media", "بدون ملفات")}
        </div>
        {captionOk && text && (
          <p dir="auto" style={{ margin: 0, padding: 10, fontSize: 13, lineHeight: 1.5 }}>
            {short}
            {text.length > 125 && <span style={{ color: "var(--ink-3)" }}> … {tx("more", "المزيد")}</span>}
          </p>
        )}
      </div>
      <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
        {tx("Approximate. The platform decides final cropping.", "تقريبي. المنصة تحدد القص النهائي.")}
      </span>
    </div>
  );
}

/* ── 5. Share ────────────────────────────────────────────────────────── */

function ShareStep({ state, setState, tx }: { state: WizardState; setState: (s: WizardState) => void; tx: Tx }) {
  const canDraft = capability(state.platform, state.kind, "nativeDraft").supported;
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <Field label={tx("When", "التوقيت")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Choice active={!state.scheduledFor && !state.asDraft} onClick={() => setState({ ...state, scheduledFor: null, asDraft: false })} title={tx("Post now", "انشر الآن")} />
          <Choice active={!!state.scheduledFor} onClick={() => setState({ ...state, asDraft: false, scheduledFor: state.scheduledFor ?? new Date(Date.now() + 36e5) })} title={tx("Schedule", "جدولة")} />
          {canDraft && (
            <Choice active={state.asDraft} onClick={() => setState({ ...state, asDraft: true, scheduledFor: null })} title={tx("Save as draft", "حفظ كمسودة")} sub={tx("In Facebook Publishing Tools", "في أدوات النشر بفيسبوك")} />
          )}
        </div>
      </Field>
      {state.scheduledFor && (
        <SchedulePicker value={state.scheduledFor} onChange={(d) => setState({ ...state, scheduledFor: d })} tx={tx} />
      )}
    </div>
  );
}

function Done({ tx, scheduled, draft, onClose }: { tx: Tx; scheduled: boolean; draft: boolean; onClose: () => void }) {
  return (
    <div style={{ display: "grid", placeItems: "center", gap: 12, padding: 40 }}>
      <IconCheck w={26} />
      <span style={{ fontSize: 15, fontWeight: 600 }}>
        {draft ? tx("Saved as a draft", "تم الحفظ كمسودة") : scheduled ? tx("Scheduled", "تمت الجدولة") : tx("Posted", "تم النشر")}
      </span>
      <button type="button" className="btn primary" onClick={onClose}>{tx("Done", "تم")}</button>
    </div>
  );
}

/* ── Small shared bits ───────────────────────────────────────────────── */

const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-2)", border: "1px solid var(--line)",
  borderRadius: 8, padding: "9px 11px", color: "var(--ink)", fontSize: 13,
  fontFamily: "inherit", outline: "none",
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{hint}</span>}
    </label>
  );
}

function Choice({ active, disabled, onClick, title, sub }: { active: boolean; disabled?: boolean; onClick: () => void; title: string; sub?: string }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      style={{
        textAlign: "start", padding: "9px 13px", borderRadius: 10, cursor: disabled ? "default" : "pointer",
        border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
        background: active ? "var(--accent-soft)" : "var(--bg-2)",
        opacity: disabled ? 0.5 : 1, minWidth: 130,
      }}>
      <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{title}</span>
      {sub && <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-3)", marginBlockStart: 2 }}>{sub}</span>}
    </button>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (c: boolean) => void; tx: Tx }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--accent)", marginBlockStart: 2 }} />
      <span>
        <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{label}</span>
        {hint && <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-3)" }}>{hint}</span>}
      </span>
    </label>
  );
}

function CsvInput({ value, onChange, tx, placeholder }: { value: string[]; onChange: (v: string[]) => void; tx: Tx; placeholder?: string }) {
  return (
    <input
      dir="auto"
      value={value.join(", ")}
      placeholder={placeholder ?? tx("Separate with commas", "افصل بفاصلة")}
      onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
      style={inputStyle}
    />
  );
}

function Note({ children, tone = "info" }: { children: React.ReactNode; tx: Tx; tone?: "info" | "warn" }) {
  const color = tone === "warn" ? "var(--warn)" : "var(--ink-3)";
  return (
    <div style={{ fontSize: 12, color, border: `1px solid ${tone === "warn" ? "var(--warn)" : "var(--line-soft)"}`, borderRadius: 8, padding: "8px 11px" }}>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode; tx: Tx }) {
  return <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{children}</span>;
}

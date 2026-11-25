/**
 * SP-10 catalog import wizard (bookings.manage):
 *  1. source: Paste | Website | File (+ per-kind .xlsx templates)
 *  2. extracting: polls GET /catalog-imports/:id
 *  3. review: rows grouped by kind; duplicates and rows with errors start
 *     unchecked; inline edits (PATCH items); the default-duration marker
 *  4. running: progress
 *  5. result: created / skipped / failed with the row errors
 * Pasted text, the page and non-template files are sent to the AI provider
 * (the source step says so); `ai_unavailable` steers to the template path.
 */
import { useEffect, useReducer, useState, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import { useFetch } from "@/api/useFetch";
import { ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { CatalogImport, Lang, ProposalItem, WeeklySchedule } from "@/lib/types";
import { MAX_CATALOG_FILE_BYTES, MAX_CATALOG_SOURCE_CHARS } from "./bookingConstants";
import { bookingErrorText, bookingKeyText, errorKey } from "./bookingErrors";
import {
  cancelCatalogImport,
  downloadTemplate,
  patchImportItems,
  runCatalogImport,
  startFileImport,
  startPasteImport,
  startUrlImport,
  type ImportKind,
} from "./catalogApi";
import { ErrorBox, FIELD, LABEL, TD, TH } from "./catalogUi";
import {
  canRun,
  editPatch,
  groupItems,
  pollMsFor,
  progressPct,
  resultSummary,
  reviewCounts,
  selectAllPatch,
  serviceDataOf,
  staffDataOf,
  stepFor,
  type EditField,
} from "./importReview";
import { scheduleSummary } from "./schedule";
import { WeeklyScheduleEditor } from "./WeeklyScheduleEditor";
import { dayErrors, fromSchedule, hasErrors, reduce, toSchedule } from "./scheduleEditor";

interface Props {
  tx: Tx;
  lang: Lang;
  tz: string;
  initialKind: ImportKind;
  onClose: () => void;
  /** Called when a run finished (the catalog changed). */
  onFinished: () => void;
  /** SP-20: open on the URL source with this address (onboarding's "Import these services"). */
  initialUrl?: string;
}

type Source = "paste" | "url" | "file";

export function CatalogImportWizard({ tx, lang, tz, initialKind, onClose, onFinished, initialUrl }: Props) {
  const [jobId, setJobId] = useState<string | null>(null);
  // The job the start call returned, shown until the job's own query answers
  // (the query is still disabled when the start call resolves, so it can't be
  // seeded through setData; live fix F2).
  const [started, setStarted] = useState<CatalogImport | null>(null);
  const jobQ = useFetch<CatalogImport>(jobId ? `/catalog-imports/${jobId}` : null, { pollMs: (d) => pollMsFor(d) });
  const job = jobId ? (jobQ.data?.id === jobId ? jobQ.data : started?.id === jobId ? started : null) : null;
  const step = stepFor(job ?? null);
  // The catalog changed once a run finishes: let the tab refresh (once per job).
  const finishedId = job && job.status === "done" ? job.id : null;
  useEffect(() => {
    if (finishedId) onFinished();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedId]);

  return (
    <Modal onClose={onClose} width={step === "review" ? 980 : 620} label={tx("Import services and staff", "استيراد الخدمات والموظفين")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14, maxHeight: "82vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>{tx("Import services and staff", "استيراد الخدمات والموظفين")}</h3>
          <Steps step={step} tx={tx} />
        </div>
        {step === "source" && <SourceStep tx={tx} initialKind={initialKind} initialUrl={initialUrl} onStarted={(j) => { setStarted(j); setJobId(j.id); }} />}
        {step === "extracting" && job && <Working tx={tx} job={job} onCancel={async () => jobQ.setData(await cancelCatalogImport(job.id))} />}
        {step === "review" && job && <ReviewStep tx={tx} lang={lang} tz={tz} job={job} setJob={(j) => jobQ.setData(j)} />}
        {step === "running" && job && <Working tx={tx} job={job} onCancel={async () => jobQ.setData(await cancelCatalogImport(job.id))} />}
        {step === "result" && job && <ResultStep tx={tx} job={job} onClose={onClose} onAgain={() => setJobId(null)} />}
      </div>
    </Modal>
  );
}

function Steps({ step, tx }: { step: string; tx: Tx }) {
  const all: [string, string, string][] = [
    ["source", "Source", "المصدر"],
    ["extracting", "Reading", "القراءة"],
    ["review", "Review", "المراجعة"],
    ["running", "Import", "الاستيراد"],
    ["result", "Done", "النتيجة"],
  ];
  return (
    <ol style={{ display: "flex", gap: 6, margin: 0, padding: 0, listStyle: "none", fontSize: 11 }}>
      {all.map(([id, en, ar]) => (
        <li key={id} aria-current={step === id ? "step" : undefined} style={{ color: step === id ? "var(--accent)" : "var(--ink-3)", fontWeight: step === id ? 600 : 400 }}>
          {tx(en, ar)}
        </li>
      ))}
    </ol>
  );
}

// ── 1. source ───────────────────────────────────────────────────────────

function SourceStep({ tx, initialKind, initialUrl, onStarted }: { tx: Tx; initialKind: ImportKind; initialUrl?: string; onStarted: (j: CatalogImport) => void }) {
  const [source, setSource] = useState<Source>(initialUrl ? "url" : "paste");
  const [kind, setKind] = useState<ImportKind>(initialKind);
  const [text, setText] = useState("");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<{ text: string; aiUnavailable: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const tooLong = text.length > MAX_CATALOG_SOURCE_CHARS;
  const fileTooBig = !!file && file.size > MAX_CATALOG_FILE_BYTES;
  const ready =
    source === "paste" ? text.trim().length > 0 && !tooLong : source === "url" ? /^https:\/\/\S+$/i.test(url.trim()) : !!file && !fileTooBig;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const job =
        source === "paste" ? await startPasteImport(text, kind) : source === "url" ? await startUrlImport(url.trim(), kind) : await startFileImport(file as File, kind);
      onStarted(job);
    } catch (e) {
      setError({ text: bookingErrorText(e, tx), aiUnavailable: e instanceof ApiError && errorKey(e) === "catalog_import.ai_unavailable" });
    } finally {
      setBusy(false);
    }
  };

  const download = async (k: "services" | "staff") => {
    try {
      await downloadTemplate(k);
    } catch (e) {
      setError({ text: bookingErrorText(e, tx), aiUnavailable: false });
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="tabs" role="tablist" style={{ padding: 0, border: 0 }}>
        {(
          [
            ["paste", "Paste text", "لصق نص"],
            ["url", "Website", "موقع إلكتروني"],
            ["file", "File", "ملف"],
          ] as const
        ).map(([id, en, ar]) => (
          <button key={id} role="tab" aria-selected={source === id} className={`tab ${source === id ? "active" : ""}`.trim()} onClick={() => setSource(id)}>
            {tx(en, ar)}
          </button>
        ))}
      </div>
      <label>
        <span style={LABEL}>{tx("What to import", "ما الذي تستورده")}</span>
        <select style={{ ...FIELD, width: 240 }} value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
          <option value="auto">{tx("Services and staff", "الخدمات والموظفون")}</option>
          <option value="services">{tx("Services only", "الخدمات فقط")}</option>
          <option value="staff">{tx("Staff only", "الموظفون فقط")}</option>
        </select>
      </label>
      {source === "paste" && (
        <label>
          <span style={LABEL}>{tx("Paste your price list, menu or team list", "الصق قائمة الأسعار أو الخدمات أو الفريق")}</span>
          <textarea style={{ ...FIELD, width: "100%", height: 180, padding: 10 }} value={text} onChange={(e) => setText(e.target.value)} />
          <span className="muted" style={{ fontSize: 11, color: tooLong ? "var(--bad)" : undefined }}>
            <bdi>{text.length.toLocaleString("en-US")}</bdi> / <bdi>{MAX_CATALOG_SOURCE_CHARS.toLocaleString("en-US")}</bdi>
          </span>
        </label>
      )}
      {source === "url" && (
        <label>
          <span style={LABEL}>{tx("One page of your website (https://…)", "صفحة واحدة من موقعك (https://…)")}</span>
          <input style={{ ...FIELD, width: "100%" }} dir="ltr" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
          <span className="muted" style={{ fontSize: 11 }}>
            {tx("Only this page is read; links are not followed. PDF pages aren't supported.", "تُقرأ هذه الصفحة فقط ولا تُتبع الروابط. صفحات PDF غير مدعومة.")}
          </span>
        </label>
      )}
      {source === "file" && (
        <div style={{ display: "grid", gap: 6 }}>
          <span style={LABEL}>{tx("A CSV or Excel file (up to 10 MB)", "ملف CSV أو Excel (حتى 10 ميغابايت)")}</span>
          <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {fileTooBig && <span style={{ color: "var(--bad)", fontSize: 12 }}>{tx("The file is larger than 10 MB.", "حجم الملف أكبر من 10 ميغابايت.")}</span>}
        </div>
      )}
      <div className="card" style={{ padding: 10, display: "grid", gap: 6, borderColor: error?.aiUnavailable ? "var(--accent)" : undefined }}>
        <div style={{ fontSize: 12 }}>
          {tx(
            "Templates are read exactly as filled in, without AI:",
            "تُقرأ القوالب كما مُلئت تمامًا، دون ذكاء اصطناعي:",
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="btn sm" onClick={() => void download("services")}>
            {tx("Services template (.xlsx)", "قالب الخدمات (.xlsx)")}
          </button>
          <button type="button" className="btn sm" onClick={() => void download("staff")}>
            {tx("Staff template (.xlsx)", "قالب الموظفين (.xlsx)")}
          </button>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {tx(
          "Pasted text, the website page and files that aren't a template are sent to our AI provider to find the services and staff. You review everything before anything is created.",
          "يُرسل النص الملصق وصفحة الموقع والملفات التي ليست قالبًا إلى مزوّد الذكاء الاصطناعي لاستخراج الخدمات والموظفين. تراجع كل شيء قبل إنشاء أي عنصر.",
        )}
      </p>
      {error && <ErrorBox>{error.text}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="btn primary" disabled={!ready || busy} onClick={() => void start()}>
          {busy ? tx("Starting…", "جارٍ البدء…") : tx("Continue", "متابعة")}
        </button>
      </div>
    </div>
  );
}

// ── 2/4. working ────────────────────────────────────────────────────────

function Working({ tx, job, onCancel }: { tx: Tx; job: CatalogImport; onCancel: () => Promise<void> }) {
  const running = job.status === "running";
  const pct = progressPct(job);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 13 }}>
        {running
          ? tx("Creating the selected services and staff…", "جارٍ إنشاء الخدمات والموظفين المحددين…")
          : tx("Reading the services and staff…", "جارٍ قراءة الخدمات والموظفين…")}
      </div>
      {running && (
        <>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ height: 8, borderRadius: 999, background: "var(--bg-3)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width .3s" }} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            <bdi>
              {job.processed} / {job.total}
            </bdi>
          </div>
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={() => void onCancel()}>
          {tx("Cancel import", "إلغاء الاستيراد")}
        </button>
      </div>
    </div>
  );
}

// ── 3. review ───────────────────────────────────────────────────────────

function ReviewStep({ tx, lang, tz, job, setJob }: { tx: Tx; lang: Lang; tz: string; job: CatalogImport; setJob: (j: CatalogImport) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, EditField>>({});
  const [busy, setBusy] = useState(false);
  const [hoursFor, setHoursFor] = useState<ProposalItem | null>(null);
  const groups = groupItems(job.items);
  const counts = reviewCounts(job.items);

  const send = async (items: { key: string; selected?: boolean; data?: Record<string, unknown> }[]) => {
    if (!items.length) return;
    setBusy(true);
    setError(null);
    try {
      setJob(await patchImportItems(job.id, items));
      setRowError((r) => {
        const next = { ...r };
        for (const i of items) delete next[i.key];
        return next;
      });
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { key?: string; field?: string } | undefined) : undefined;
      if (body?.key && body.field) setRowError((r) => ({ ...r, [body.key as string]: body.field as EditField }));
      setError(bookingErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const edit = (item: ProposalItem, field: EditField, raw: string | WeeklySchedule | string[]) => {
    const r = editPatch(item, field, raw);
    if (!r.ok) {
      setRowError((x) => ({ ...x, [item.key]: field }));
      return;
    }
    void send([r.patch]);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setJob(await runCatalogImport(job.id));
    } catch (e) {
      setError(bookingErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const dupText = (i: ProposalItem) =>
    i.duplicateOf
      ? i.duplicateOf.id
        ? `${tx("Already in catalog", "موجود في الكتالوج")}: ${i.duplicateOf.name}`
        : `${tx("Same as another row", "مكرر لصف آخر")}: ${i.duplicateOf.name}`
      : null;

  const cell = (item: ProposalItem, field: EditField, value: string | number | null, opts: { width?: number; dir?: "ltr" | "rtl" } = {}) => (
    <input
      key={`${item.key}-${field}-${value ?? ""}`}
      aria-label={field}
      aria-invalid={rowError[item.key] === field || item.error?.field === field || undefined}
      defaultValue={value ?? ""}
      dir={opts.dir}
      disabled={busy}
      style={{
        ...FIELD,
        height: 28,
        width: opts.width ?? 140,
        borderColor: rowError[item.key] === field || item.error?.field === field ? "var(--bad)" : undefined,
      }}
      onBlur={(e) => {
        if (e.target.value !== String(value ?? "")) edit(item, field, e.target.value);
      }}
    />
  );

  const check = (i: ProposalItem) => (
    <input
      type="checkbox"
      aria-label={tx("Import this row", "استيراد هذا الصف")}
      checked={i.selected}
      disabled={busy}
      onChange={(e) => void send([{ key: i.key, selected: e.target.checked }])}
    />
  );

  const groupHeader = (label: string, items: ProposalItem[]) => (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <h4 style={{ margin: 0, fontSize: 14, flex: 1 }}>
        {label} (<bdi>{items.length}</bdi>)
      </h4>
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void send(selectAllPatch(items, true))}>
        {tx("Select all", "تحديد الكل")}
      </button>
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void send(selectAllPatch(items, false))}>
        {tx("Select none", "إلغاء التحديد")}
      </button>
    </div>
  );

  const note = (i: ProposalItem): ReactNode => {
    const d = dupText(i);
    const field = rowError[i.key] ?? i.error?.field;
    return (
      <>
        {d && <div style={{ fontSize: 11, color: "var(--warn)" }}><bdi>{d}</bdi></div>}
        {field && (
          <div style={{ fontSize: 11, color: "var(--bad)" }}>
            {bookingKeyText("catalog_import.item_invalid", { field }, tx)}
          </div>
        )}
      </>
    );
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 13 }}>
        {tx("Check what was found. Duplicates and rows with problems start unchecked.", "راجع ما تم العثور عليه. تبدأ الصفوف المكررة وذات المشكلات غير محددة.")}{" "}
        <span className="muted">
          ({tx("selected", "المحدد")} <bdi>{counts.selected}</bdi> / <bdi>{counts.total}</bdi>)
        </span>
      </div>
      {(job.notes ?? []).map((n) => (
        <div key={n.kind} className="card" style={{ padding: 8, fontSize: 12, color: "var(--warn)" }}>
          {n.kind === "services"
            ? tx(`Only the first ${n.kept} services are shown (${n.dropped} more were found).`, `تُعرض أول ${n.kept} خدمة فقط (عُثر على ${n.dropped} أخرى).`)
            : tx(`Only the first ${n.kept} staff are shown (${n.dropped} more were found).`, `يُعرض أول ${n.kept} موظفًا فقط (عُثر على ${n.dropped} آخرين).`)}
        </div>
      ))}

      {groups.services.length > 0 && (
        <section style={{ display: "grid", gap: 6 }}>
          {groupHeader(tx("Services", "الخدمات"), groups.services)}
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={TH} />
                  <th style={TH}>{tx("Name", "الاسم")}</th>
                  <th style={TH}>{tx("Arabic name", "الاسم بالعربية")}</th>
                  <th style={TH}>{tx("Minutes", "الدقائق")}</th>
                  <th style={TH}>{tx("Price", "السعر")}</th>
                  <th style={TH}>{tx("Currency", "العملة")}</th>
                </tr>
              </thead>
              <tbody>
                {groups.services.map((i) => {
                  const d = serviceDataOf(i);
                  return (
                    <tr key={i.key} style={{ opacity: i.selected ? 1 : 0.7 }}>
                      <td style={TD}>{check(i)}</td>
                      <td style={TD}>
                        {cell(i, "name", d.name, { dir: "ltr" })}
                        {note(i)}
                      </td>
                      <td style={TD}>{cell(i, "nameAr", d.nameAr, { dir: "rtl" })}</td>
                      <td style={TD}>
                        {cell(i, "durationMin", d.durationMin, { width: 70, dir: "ltr" })}
                        {d.durationDefaulted && (
                          <div style={{ fontSize: 11, color: "var(--warn)" }}>{tx("Not stated: default 60", "غير مذكورة: افتراضيًا 60")}</div>
                        )}
                      </td>
                      <td style={TD}>{cell(i, "price", d.price, { width: 90, dir: "ltr" })}</td>
                      <td style={TD}>{cell(i, "currency", d.currency, { width: 60, dir: "ltr" })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {groups.staff.length > 0 && (
        <section style={{ display: "grid", gap: 6 }}>
          {groupHeader(tx("Staff", "الموظفون"), groups.staff)}
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={TH} />
                  <th style={TH}>{tx("Name", "الاسم")}</th>
                  <th style={TH}>{tx("Arabic name", "الاسم بالعربية")}</th>
                  <th style={TH}>{tx("Role", "المسمى")}</th>
                  <th style={TH}>{tx("Working hours", "ساعات العمل")}</th>
                  <th style={TH}>{tx("Services", "الخدمات")}</th>
                </tr>
              </thead>
              <tbody>
                {groups.staff.map((i) => {
                  const d = staffDataOf(i);
                  return (
                    <tr key={i.key} style={{ opacity: i.selected ? 1 : 0.7 }}>
                      <td style={TD}>{check(i)}</td>
                      <td style={TD}>
                        {cell(i, "name", d.name)}
                        {note(i)}
                      </td>
                      <td style={TD}>{cell(i, "nameAr", d.nameAr, { dir: "rtl" })}</td>
                      <td style={TD}>{cell(i, "role", d.role, { width: 110 })}</td>
                      <td style={TD}>
                        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setHoursFor(i)} style={{ textAlign: "start" }}>
                          <bdi>{scheduleSummary(d.schedule, lang)}</bdi>
                        </button>
                      </td>
                      <td style={TD}>
                        <input
                          key={`${i.key}-services-${d.services.join("|")}`}
                          aria-label="services"
                          defaultValue={d.services.join(", ")}
                          disabled={busy}
                          style={{ ...FIELD, height: 28, width: 180 }}
                          onBlur={(e) => {
                            const list = e.target.value.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
                            if (list.join("|") !== d.services.join("|")) edit(i, "services", list);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
        {counts.blocking > 0 && (
          <span style={{ fontSize: 12, color: "var(--bad)" }}>{tx("Fix or uncheck the rows with problems.", "أصلح الصفوف ذات المشكلات أو ألغِ تحديدها.")}</span>
        )}
        <button type="button" className="btn" disabled={busy} onClick={async () => setJob(await cancelCatalogImport(job.id))}>
          {tx("Cancel import", "إلغاء الاستيراد")}
        </button>
        <button type="button" className="btn primary" disabled={busy || !canRun(job.items)} onClick={() => void run()}>
          {tx(`Import ${counts.selected} selected`, `استيراد ${counts.selected} محدد`)}
        </button>
      </div>

      {hoursFor && (
        <HoursDialog
          tx={tx}
          lang={lang}
          tz={tz}
          schedule={staffDataOf(hoursFor).schedule}
          onClose={() => setHoursFor(null)}
          onSave={(s) => {
            const item = hoursFor;
            setHoursFor(null);
            edit(item, "schedule", s);
          }}
        />
      )}
    </div>
  );
}

function HoursDialog({ tx, lang, tz, schedule, onClose, onSave }: { tx: Tx; lang: Lang; tz: string; schedule: WeeklySchedule; onClose: () => void; onSave: (s: WeeklySchedule) => void }) {
  const [model, dispatch] = useReducer(reduce, schedule, fromSchedule);
  return (
    <Modal onClose={onClose} width={600} zIndex={110} label={tx("Working hours", "ساعات العمل")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Working hours", "ساعات العمل")}</h3>
        <WeeklyScheduleEditor model={model} dispatch={dispatch} errors={dayErrors(model)} tx={tx} lang={lang} tz={tz} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" disabled={hasErrors(model)} onClick={() => onSave(toSchedule(model))}>
            {tx("Apply", "تطبيق")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── 5. result ───────────────────────────────────────────────────────────

function ResultStep({ tx, job, onClose, onAgain }: { tx: Tx; job: CatalogImport; onClose: () => void; onAgain: () => void }) {
  const r = resultSummary(job);
  const failedKey = job.status === "failed" && job.errorKey ? bookingKeyText(job.errorKey, {}, tx) : null;
  const reason = (x: { reason: string; missing?: string[] }) =>
    x.reason === "service_not_found"
      ? `${tx("No service named", "لا توجد خدمة باسم")}: ${(x.missing ?? []).join(", ")}`
      : x.reason === "write_failed"
        ? tx("Could not be created.", "تعذّر إنشاؤه.")
        : tx("Invalid data.", "بيانات غير صالحة.");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {job.status === "done" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {(
            [
              ["Created", "تم إنشاؤه", r.created],
              ["Skipped", "تم تخطيه", r.skipped],
              ["Failed", "فشل", r.failed],
            ] as const
          ).map(([en, ar, n]) => (
            <div key={en} className="card" style={{ padding: 10 }}>
              <div className="muted" style={{ fontSize: 11 }}>{tx(en, ar)}</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                <bdi>{n}</bdi>
              </div>
            </div>
          ))}
        </div>
      )}
      {job.status === "cancelled" && <div>{tx("The import was cancelled.", "أُلغي الاستيراد.")}</div>}
      {failedKey && <ErrorBox>{failedKey}</ErrorBox>}
      {job.status === "failed" && !failedKey && <ErrorBox>{tx("The import failed.", "فشل الاستيراد.")}</ErrorBox>}
      {r.rowErrors.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{tx("Rows to check", "صفوف تحتاج إلى مراجعة")}</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
            {r.rowErrors.map((x) => (
              <li key={`${x.key}-${x.reason}`}>
                <bdi style={{ fontWeight: 500 }}>{x.name}</bdi>: {reason(x)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onAgain}>
          {tx("Import more", "استيراد المزيد")}
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          {tx("Close", "إغلاق")}
        </button>
      </div>
    </div>
  );
}

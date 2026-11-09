import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import type { Permission } from "@/lib/permissions";
import type { CustomFieldDef, Lang, Pipeline, Segment, TeamMember } from "@/lib/types";
import { validateMapping } from "./importMapping";
import { messageText } from "./importMessages";
import {
  errorKey, listImports, previewImport, runImport, uploadImport,
  type ImportKind, type ImportPreview, type ImportUpload,
} from "./importApi";
import { StepUpload } from "./StepUpload";
import { EMPTY_OPTIONS, StepMap, toOptions, type OptionsDraft } from "./StepMap";
import { StepPreview } from "./StepPreview";
import { StepRun, pct, useImportJob } from "./StepRun";
import { ERROR_BOX } from "./styles";

type Step = 0 | 1 | 2 | 3;

interface Props {
  tx: Tx;
  lang: Lang;
  kind: ImportKind;
  /** Closing never stops a running job; `runningJobId` lets the parent keep watching it. */
  onClose: (runningJobId: string | null) => void;
  /** Contacts or groups changed (import finished and the user chose to view the result). */
  onImported: () => void;
}

function Steps({ tx, step }: { tx: Tx; step: Step }) {
  const labels = [tx("Upload", "الرفع"), tx("Map", "الربط"), tx("Preview", "المعاينة"), tx("Import", "الاستيراد")];
  // Flex + logical gaps: the order follows the document direction, so it mirrors in RTL.
  return (
    <ol style={{ display: "flex", gap: 14, listStyle: "none", margin: 0, padding: 0, flexWrap: "wrap" }}>
      {labels.map((l, i) => (
        <li key={l} aria-current={i === step ? "step" : undefined} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: i <= step ? "var(--ink)" : "var(--ink-3)", fontWeight: i === step ? 600 : 400 }}>
          <span style={{
            width: 20, height: 20, borderRadius: 999, display: "grid", placeItems: "center", fontSize: 11,
            background: i < step ? "var(--accent)" : i === step ? "var(--accent-soft)" : "var(--bg-2)",
            color: i < step ? "#fff" : "inherit", border: i === step ? "1px solid var(--accent)" : "1px solid transparent",
          }}>{i + 1}</span>
          {l}
        </li>
      ))}
    </ol>
  );
}

export function ImportWizard({ tx, lang, kind, onClose, onImported }: Props) {
  const perms = usePermissions();
  const can = (p: string) => perms.can(p as Permission);
  const [step, setStep] = useState<Step>(0);
  const [upload, setUpload] = useState<ImportUpload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<OptionsDraft>(() => EMPTY_OPTIONS(kind));
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customQ = useFetch<CustomFieldDef[]>("/custom-fields");
  const teamQ = useFetch<TeamMember[]>("/team");
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const segQ = useFetch<Segment[]>("/segments");
  const groups = (segQ.data ?? []).filter((s) => s.origin === "manual");

  const fail = (e: unknown) => setError(messageText(errorKey(e), tx));

  const onFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const u = await uploadImport(file, kind);
      setUpload(u);
      setMapping({ ...u.suggestedMapping });
      setStep(1);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  // A chosen group must be complete (audience imports always need one).
  const groupOk = options.groupMode === "existing" ? !!options.groupId : options.groupMode === "new" ? !!options.newGroupName.trim() : kind !== "audience";
  const mapOk = upload !== null && "ok" in validateMapping(mapping) && groupOk &&
    !(options.pipelineId && upload.totalRows > 500);

  const doPreview = async () => {
    if (!upload || !mapOk) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewImport(upload.id, mapping, toOptions(options, can)));
      setStep(2);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const doRun = async () => {
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      const j = await runImport(upload.id);
      setJobId(j.id);
      setStep(3);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  // The run step owns polling and reports whether the job is still going, so closing can hand it off.
  const [running, setRunning] = useState(true);
  const close = () => onClose(step === 3 && running ? jobId : null);
  const viewResult = () => { onImported(); onClose(null); };

  return (
    <Modal onClose={busy ? () => {} : close} width={640} label={kind === "audience" ? tx("Import audience", "استيراد جمهور") : tx("Import contacts", "استيراد جهات الاتصال")}
      panelStyle={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{kind === "audience" ? tx("Import audience", "استيراد جمهور") : tx("Import contacts", "استيراد جهات الاتصال")}</h3>
        <Steps tx={tx} step={step} />
      </div>

      {step === 0 && <StepUpload tx={tx} busy={busy} error={error} onFile={onFile} />}
      {step === 1 && upload && (
        <StepMap
          tx={tx} lang={lang} kind={kind} upload={upload} mapping={mapping} onMapping={setMapping}
          options={options} onOptions={setOptions} customDefs={customQ.data ?? []} team={teamQ.data ?? []}
          pipelines={pipelinesQ.data ?? []} groups={groups} can={can} error={error}
        />
      )}
      {step === 2 && preview && (
        <>
          <StepPreview tx={tx} preview={preview} updateExisting={options.updateExisting && can("contacts.update")} />
          {error && <div role="alert" style={ERROR_BOX}>{error}</div>}
        </>
      )}
      {step === 3 && jobId && <StepRun tx={tx} jobId={jobId} onStatus={(st) => setRunning(st === "running" || st === "previewed")} onViewContacts={viewResult} onClose={close} />}

      {step < 3 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {step > 0 && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => { setError(null); setStep((step - 1) as Step); }}>
              {tx("Back", "رجوع")}
            </button>
          )}
          <button type="button" className="btn ghost" disabled={busy} onClick={close}>{tx("Cancel", "إلغاء")}</button>
          {step === 1 && (
            <button type="button" className="btn primary" disabled={busy || !mapOk} onClick={doPreview}>
              {busy ? tx("Checking…", "جارٍ الفحص…") : tx("Preview", "معاينة")}
            </button>
          )}
          {step === 2 && preview && (
            <button type="button" className="btn primary" disabled={busy || (preview.counts.new + preview.counts.update === 0 && kind !== "audience")} onClick={doRun}>
              {busy ? tx("Starting…", "جارٍ البدء…") : tx("Start import", "بدء الاستيراد")}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Header chip for an import that keeps running after the wizard was closed.
 *  Looks for a running job on mount (so a page reload still shows it) and
 *  polls until it ends, then calls `onFinished`. */
export function ImportChip({ tx, watchId, onFinished }: { tx: Tx; watchId: string | null; onFinished: () => void }) {
  const [found, setFound] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listImports(10)
      .then((rows) => { if (live) setFound(rows.find((r) => r.status === "running")?.id ?? null); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  const id = watchId ?? found;
  const { job } = useImportJob(id && id !== ended ? id : null, () => { setEnded(id); onFinished(); });
  if (!id || id === ended || !job || job.status !== "running") return null;
  return (
    <span
      role="status"
      className="mono"
      style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-ring)" }}
    >
      {tx(`Import running ${pct(job)}%`, `الاستيراد قيد التنفيذ ${pct(job)}%`)}
    </span>
  );
}

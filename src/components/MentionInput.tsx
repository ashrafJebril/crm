import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useFetch } from "@/api/useFetch";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { insertMentionPlain, mentionQuery, serializeMentions } from "@/lib/mentions";
import type { TeamMember } from "@/lib/types";

/**
 * Mention editing approach (side map): the textarea holds PLAIN text, with a
 * picked member shown as `@Name`. That keeps `dir="auto"` editing, caret
 * movement and IME input reliable in both Arabic and English, instead of
 * fighting a raw `@[Name](user:id)` token the user could corrupt mid-edit.
 * The members picked are remembered in `picked`; `serialize()` turns each
 * still-present `@Name` into the wire token on submit. Names the user edited or
 * typed by hand without picking stay plain text (and notify nobody).
 */
export function useMentionDraft() {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Array<{ id: string; name: string }>>([]);
  return {
    text,
    setText,
    picked,
    pick: (m: { id: string; name: string }) =>
      setPicked((p) => (p.some((x) => x.id === m.id) ? p : [...p, { id: m.id, name: m.name }])),
    /** `members` (the team) lets a hand-typed full "@Name" still become a mention;
     *  picked members take precedence on duplicate names (they come last). */
    serialize: (members: Array<{ id: string; name: string }> = []) =>
      serializeMentions(text.trim(), [...members, ...picked]),
    reset: () => {
      setText("");
      setPicked([]);
    },
  };
}

export type MentionDraft = ReturnType<typeof useMentionDraft>;

interface Props {
  draft: MentionDraft;
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
}

const MAX_OPTIONS = 6;

export function MentionInput({ draft, placeholder, rows = 2, ariaLabel, autoFocus, onSubmit }: Props) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const team = useFetch<TeamMember[]>("/team");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();

  const q = mentionQuery(draft.text, caret);
  const options = useMemo(() => {
    if (!q) return [];
    const needle = q.query.toLowerCase();
    return (team.data ?? [])
      .filter((m) => m.name.toLowerCase().includes(needle))
      .slice(0, MAX_OPTIONS);
  }, [q, team.data]);
  const open = !!q && !dismissed && options.length > 0;
  const activeIdx = Math.min(active, Math.max(0, options.length - 1));

  const choose = (m: TeamMember) => {
    const el = ref.current;
    const pos = el?.selectionStart ?? caret;
    const r = insertMentionPlain(draft.text, pos, m);
    draft.setText(r.body);
    draft.pick(m);
    setCaret(r.caret);
    setActive(0);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((activeIdx + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((activeIdx - 1 + options.length) % options.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        choose(options[activeIdx]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <textarea
        ref={ref}
        dir="auto"
        value={draft.text}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIdx}` : undefined}
        onChange={(e) => {
          draft.setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
          setDismissed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onBlur={() => setDismissed(true)}
        style={{
          width: "100%",
          minHeight: 36,
          resize: "vertical",
          border: 0,
          outline: 0,
          background: "transparent",
          color: "inherit",
          fontSize: 13,
          fontFamily: "inherit",
          lineHeight: 1.4,
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={tx("Mention a teammate", "الإشارة إلى زميل")}
          style={{
            position: "absolute",
            insetInlineStart: 0,
            top: "100%",
            zIndex: 60,
            margin: "4px 0 0",
            padding: 4,
            listStyle: "none",
            minWidth: 200,
            maxWidth: 280,
            background: "var(--bg-elev)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {options.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              // mousedown (not click) so the textarea blur doesn't close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m);
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                background: i === activeIdx ? "var(--bg-2)" : "transparent",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 999,
                  background: m.color || "var(--bg-3)",
                  color: "#fff",
                  fontSize: 9,
                  display: "grid",
                  placeItems: "center",
                  flex: "0 0 auto",
                }}
              >
                {m.initials}
              </span>
              <span dir="auto" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

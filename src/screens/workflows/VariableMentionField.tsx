import { useEffect, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { SuggestionOptions } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";

export interface VariableOption {
  path: string;
  label: string;
}

function serializeDoc(doc: JSONContent): string {
  const parts: string[] = [];
  function walk(node: JSONContent) {
    if (node.type === "text") parts.push(node.text ?? "");
    else if (node.type === "mention") parts.push(`{{${node.attrs?.id ?? ""}}}`);
    for (const child of node.content ?? []) walk(child);
    if (node.type === "paragraph") parts.push("\n");
  }
  for (const child of doc.content ?? []) walk(child);
  return parts.join("").replace(/\n$/, "");
}

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function parseTemplate(template: string): JSONContent {
  const content: JSONContent[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(template))) {
    if (match.index > lastIndex) content.push({ type: "text", text: template.slice(lastIndex, match.index) });
    content.push({ type: "mention", attrs: { id: match[1], label: match[1] } });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < template.length) content.push({ type: "text", text: template.slice(lastIndex) });
  return { type: "doc", content: [{ type: "paragraph", content: content.length ? content : undefined }] };
}

function renderSuggestionItems(
  container: HTMLDivElement,
  items: VariableOption[],
  command: (item: { id: string; label: string }) => void,
) {
  container.innerHTML = "";
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "mention-suggestion-item";
    el.textContent = item.label;
    el.onmousedown = (e) => {
      e.preventDefault();
      command({ id: item.path, label: item.label });
    };
    container.appendChild(el);
  });
}

export function VariableMentionField({
  value,
  onChange,
  variables,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  variables: VariableOption[];
  placeholder?: string;
}) {
  const suggestion = useMemo<Partial<SuggestionOptions>>(
    () => ({
      char: "{{",
      items: ({ query }: { query: string }) =>
        variables.filter((v) => v.label.toLowerCase().includes(query.toLowerCase())).slice(0, 8),
      render: () => {
        let popup: TippyInstance[];
        let list: HTMLDivElement;
        return {
          onStart: (props) => {
            list = document.createElement("div");
            list.className = "mention-suggestion-list";
            renderSuggestionItems(list, props.items as VariableOption[], props.command);
            popup = tippy("body", {
              getReferenceClientRect: () => (props.clientRect?.() ?? new DOMRect()) as DOMRect,
              content: list,
              showOnCreate: true,
              interactive: true,
              trigger: "manual",
              placement: "bottom-start",
            });
          },
          onUpdate: (props) => {
            renderSuggestionItems(list, props.items as VariableOption[], props.command);
            popup[0].setProps({ getReferenceClientRect: () => (props.clientRect?.() ?? new DOMRect()) as DOMRect });
          },
          onKeyDown: (props) => {
            if (props.event.key === "Escape") {
              popup[0].hide();
              return true;
            }
            return false;
          },
          onExit: () => popup[0].destroy(),
        };
      },
    }),
    [variables],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, codeBlock: false }),
      Mention.configure({
        HTMLAttributes: { class: "variable-chip" },
        suggestion,
        // Note: `renderLabel` is deprecated in the installed tiptap 3.x (@tiptap/extension-mention@3.31.3)
        // in favor of `renderText` (plain-text extraction, e.g. copy/paste) and `renderHTML` (chip DOM).
        // Both reproduce the brief's original `{{label ?? id}}` display text.
        renderText: ({ node }) => `{{${(node.attrs.label as string | null) ?? node.attrs.id}}}`,
        renderHTML: ({ node, options }) => [
          "span",
          options.HTMLAttributes,
          `{{${(node.attrs.label as string | null) ?? node.attrs.id}}}`,
        ],
      }),
    ],
    content: parseTemplate(value),
    onUpdate: ({ editor: e }) => onChange(serializeDoc(e.getJSON())),
  });

  useEffect(() => {
    if (editor && serializeDoc(editor.getJSON()) !== value) {
      editor.commands.setContent(parseTemplate(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div>
      <EditorContent editor={editor} className="variable-mention-field" />
      {placeholder && !value && (
        <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
          {placeholder}
        </p>
      )}
      <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        {"Type \"{{\" to insert a variable."}
      </p>
    </div>
  );
}

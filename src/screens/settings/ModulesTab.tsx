import { usePermissions } from "@/auth/usePermissions";
import { makeTx } from "@/lib/tx";
import { useTweaks } from "@/tweaks/context";
import { visibleModules } from "./modules";

/** SP-11 module settings hub: each module the member can configure, with
 *  links to where it is configured. */
export function ModulesTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can, loading } = usePermissions();
  if (loading) return null;
  const modules = visibleModules(can);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {modules.map((m) => (
        <div key={m.key} className="card" style={{ padding: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{tx(m.title, m.titleAr)}</h3>
          <div style={{ fontSize: 13, color: "var(--ink-3)", margin: "4px 0 10px" }}>{tx(m.description, m.descriptionAr)}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {m.links.map((l) => (
              <a key={`${l.href}|${l.label}`} className="btn" href={l.href}>
                {tx(l.label, l.labelAr)}
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

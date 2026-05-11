import { Fragment, type ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: string[];
}

export function PageHeader({ title, subtitle, actions, breadcrumbs }: PageHeaderProps) {
  return (
    <div style={{ padding: "20px 24px 12px" }}>
      {breadcrumbs && (
        <div className="crumbs" style={{ marginBottom: 6 }}>
          {breadcrumbs.map((b, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="sep">/</span>}
              <span className={i === breadcrumbs.length - 1 ? "now" : ""}>{b}</span>
            </Fragment>
          ))}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </h1>
          {subtitle && (
            <p style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 13 }}>{subtitle}</p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>
      </div>
    </div>
  );
}

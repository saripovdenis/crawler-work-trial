import type { MouseEvent, ReactNode } from "react";

const items = [
  { id: "overview", label: "Overview", href: "/" },
  { id: "coverage", label: "Coverage", href: "/reconciliation" },
  { id: "freshness", label: "Freshness", href: "/freshness" },
  { id: "crawler-only", label: "Crawler-only", href: "/crawler-only" },
  { id: "requests", label: "Requests", href: "/?view=requests" },
  { id: "articles", label: "Articles", href: "/?view=articles" },
] as const;
export type View = (typeof items)[number]["id"];

// The one frame for every page. A page that renders several views itself
// passes onSelect and returns true for the views it switches without a reload.
export function Shell({
  active,
  onSelect,
  children,
}: {
  active: View;
  onSelect?: (view: View) => boolean;
  children: ReactNode;
}) {
  const select = (event: MouseEvent, view: View) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (onSelect?.(view)) event.preventDefault();
  };
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="/">Crawler</a>
          <nav aria-label="Dashboard">
            {items.map((item) => (
              <a
                key={item.id}
                href={item.href}
                aria-current={active === item.id ? "page" : undefined}
                onClick={(event) => select(event, item.id)}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <a className="source" href="https://github.com/saripovdenis/crawler-work-trial" target="_blank" rel="noreferrer">
            Source ↗
          </a>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      <div className="page-meta">{children}</div>
    </div>
  );
}

export function Alerts({ items }: { items: (string | false | null | undefined)[] }) {
  const shown = items.filter(Boolean) as string[];
  return shown.length ? (
    <div className="alerts" role="status">
      {shown.map((text) => <p key={text}>{text}</p>)}
    </div>
  ) : null;
}

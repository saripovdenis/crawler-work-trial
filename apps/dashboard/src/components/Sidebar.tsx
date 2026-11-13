import type { MouseEvent } from "react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Bot,
  Clock3,
  FileText,
  GitBranch,
  LayoutDashboard,
  ScanSearch,
} from "lucide-react";

const items = [
  { id: "overview", label: "Overview", href: "/?view=overview", icon: LayoutDashboard },
  { id: "requests", label: "Request log", href: "/?view=requests", icon: Activity },
  { id: "articles", label: "Articles", href: "/?view=articles", icon: FileText },
  { id: "schedule", label: "Poll schedule", href: "/?view=schedule", icon: Clock3 },
  { id: "charts", label: "Charts", href: "/charts", icon: BarChart3 },
  { id: "coverage", label: "Coverage", href: "/reconciliation", icon: ScanSearch },
  { id: "freshness", label: "Freshness", href: "/freshness", icon: Clock3 },
  { id: "crawler-only", label: "Crawler-only", href: "/crawler-only", icon: Bot },
] as const;
export type View = (typeof items)[number]["id"];

// The one sidebar for every page. A page that renders several views itself
// passes onSelect and returns true for the views it switches without a reload.
export function Sidebar({
  active,
  onSelect,
}: {
  active: View;
  onSelect?: (view: View) => boolean;
}) {
  const select = (event: MouseEvent, view: View) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (onSelect?.(view)) event.preventDefault();
  };
  return (
    <aside className="sidebar">
      <a className="wordmark" href="/" aria-label="Crawler observatory home">
        Crawler
      </a>
      <nav aria-label="Dashboard">
        {items.map((item) => (
          <a
            key={item.id}
            className={`nav-item ${active === item.id ? "active" : ""}`}
            href={item.href}
            aria-current={active === item.id ? "page" : undefined}
            onClick={(event) => select(event, item.id)}
          >
            <item.icon size={17} />
            {item.label}
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <a
          href="https://github.com/saripovdenis/crawler-work-trial"
          target="_blank"
          rel="noreferrer"
        >
          <GitBranch size={16} />
          View source
          <ArrowUpRight size={14} />
        </a>
      </div>
    </aside>
  );
}

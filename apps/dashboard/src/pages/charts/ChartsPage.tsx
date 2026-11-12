import { ScanSearch, Activity, BarChart3, ChevronRight, Clock3, FileText, Globe2, LayoutDashboard } from 'lucide-react';
import { ParsingQuality } from './ParsingQuality';
import '../App.css';
import './charts.css';

// Add widgets to this grid; each widget owns its endpoint and refresh lifecycle.
export default function ChartsPage() {
  return <div className="app-shell charts-page">
    <aside className="sidebar">
      <a className="wordmark" href="/" aria-label="Crawler observatory home">exa<span className="wordmark-dot">*</span><span className="brand-divider"/><span className="brand-project">crawler<br/>observatory</span></a>
      <div className="workspace"><span className="workspace-icon"><Globe2 size={17}/></span><div>News discovery<span>Work trial / v1.0</span></div><ChevronRight size={14}/></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Dashboard">
        <a className="nav-item" href="/?view=overview"><LayoutDashboard size={17}/>Overview</a>
        <a className="nav-item" href="/?view=requests"><Activity size={17}/>Request log</a>
        <a className="nav-item" href="/?view=articles"><FileText size={17}/>Articles</a>
        <a className="nav-item" href="/?view=schedule"><Clock3 size={17}/>Poll schedule</a>
        <a className="nav-item active" href="/charts" aria-current="page"><BarChart3 size={17}/>Charts</a>
      <a className="nav-item" href="/reconciliation"><ScanSearch size={17}/>Coverage</a></nav>
      <div className="sidebar-note"><BarChart3 size={18}/><strong>Measure what arrives.</strong><p>Parsing quality, across every source.</p></div>
    </aside>
    <main>
      <header className="topbar"><div className="breadcrumb">Workspace<ChevronRight size={13}/><strong>Charts</strong></div><span>All times UTC</span></header>
      <div className="charts-content">
        <div className="charts-heading"><span className="charts-eyebrow">OBSERVABILITY</span><h1>Charts<span>.</span></h1><p>A closer look at the data coming in.</p></div>
        <div className="widgets-grid"><ParsingQuality/></div>
      </div>
    </main>
  </div>;
}

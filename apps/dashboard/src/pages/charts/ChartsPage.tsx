import { Sidebar } from '@/components/Sidebar';
import { ParsingQuality } from './ParsingQuality';
import '../App.css';
import './charts.css';

// Add widgets to this grid; each widget owns its endpoint and refresh lifecycle.
export default function ChartsPage() {
  return <div className="app-shell">
    <Sidebar active="charts"/>
    <main>
      <div className="charts-content">
        <div className="charts-heading"><h1>Charts</h1><p>A closer look at the data coming in.</p></div>
        <div className="widgets-grid"><ParsingQuality/></div>
      </div>
    </main>
  </div>;
}

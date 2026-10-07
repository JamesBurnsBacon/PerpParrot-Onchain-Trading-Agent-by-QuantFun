import { Parrot } from "./ParrotSymbols";
import { DemoModal } from "./DemoModal";
import { DEMO_VIDEO } from "../../lib/demo-video";

// Sticky bar of the dashboard half: the product name and three anchors. It shows nothing about the
// executor while all is well; `alert` is set only for an abnormal state (paused, offline).
// A div, not a second <header>: the hero already is the page's banner landmark.
export function DashHeader({ alert }: { alert?: string }) {
  return (
    <div className="lp-dh">
      <a className="lp-dbrand" href="#top">
        <Parrot />
        <b>PerpParrot</b>
      </a>
      <nav aria-label="Dashboard sections">
        <a href="#perf">Performance</a>
        <a href="#pipeline">Pipeline</a>
        <a href="#roster">Roster</a>
      </nav>
      {alert && (
        <span className="lp-alert" role="status">
          {alert}
        </span>
      )}
      <div className="lp-dh-actions">
        <a className="lp-dh-action lp-dh-pro" href="/parrot">
          <Parrot />
          Pro
        </a>
        {DEMO_VIDEO && <DemoModal video={DEMO_VIDEO} />}
      </div>
    </div>
  );
}

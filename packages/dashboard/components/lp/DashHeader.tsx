import { Parrot } from "./ParrotSymbols";
import { ScrollBuddy } from "./ScrollBuddy";
import { DemoModal } from "./DemoModal";
import { DEMO_VIDEO } from "../../lib/demo-video";

// A small gold crown for the Pro button: the badge of the paid tier, not the product logo.
function ProCrown() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5 7.8 12 12 5.5 16.2 12 20.5 8.5 19 18H5Z" fill="#f4c430" stroke="#8a5a06" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5.6 20.4h12.8" stroke="#8a5a06" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="3.5" cy="8.5" r="1.4" fill="#f4c430" stroke="#8a5a06" strokeWidth="1.1" />
      <circle cx="12" cy="5.2" r="1.4" fill="#f4c430" stroke="#8a5a06" strokeWidth="1.1" />
      <circle cx="20.5" cy="8.5" r="1.4" fill="#f4c430" stroke="#8a5a06" strokeWidth="1.1" />
    </svg>
  );
}

// Sticky bar of the dashboard half: the product name and three anchors. It shows nothing about the
// executor while all is well; `alert` is set only for an abnormal state (paused, offline).
// A div, not a second <header>: the hero already is the page's banner landmark.
export function DashHeader({ alert }: { alert?: string }) {
  return (
    <div className="lp-dh">
      {/* Inside the sticky bar, so the progress bar moves with it (including the overscroll bounce at the page ends). */}
      <ScrollBuddy />
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
          <ProCrown />
          Pro Chat
        </a>
        {DEMO_VIDEO && <DemoModal video={DEMO_VIDEO} />}
      </div>
    </div>
  );
}

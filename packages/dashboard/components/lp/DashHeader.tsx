import { Parrot } from "./ParrotSymbols";

// Sticky header of the dashboard half: the product name and three anchors, nothing else.
export function DashHeader() {
  return (
    <header className="lp-dh">
      <a className="lp-dbrand" href="#top">
        <Parrot />
        <b>PerpParrot</b>
      </a>
      <nav aria-label="Dashboard sections">
        <a href="#perf">Performance</a>
        <a href="#pipeline">Pipeline</a>
        <a href="#roster">Roster</a>
      </nav>
    </header>
  );
}

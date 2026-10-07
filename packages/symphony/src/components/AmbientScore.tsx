import { useEffect } from "react";
import { useConductor } from "../art/ConductorProvider";
import "./ambient-score.css";

function scorePath(index: number) {
  let path = "";
  for (let step = 0; step <= 90; step++) {
    const x = (step / 90) * 1440;
    const y =
      280 +
      index * 78 +
      Math.sin(x * 0.004 + index * 0.8) * (50 + index * 9) +
      Math.sin(x * 0.009 - index * 0.4) * 20;
    path += `${step ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return path;
}
const waves = Array.from({ length: 7 }, (_, index) => scorePath(index));
export function AmbientScore() {
  const conductor = useConductor();
  useEffect(() => {
    let targetX = 0,
      targetY = 0,
      x = 0,
      y = 0;
    const element = document.documentElement;
    const move = (event: PointerEvent) => {
      targetX = (event.clientX / window.innerWidth - 0.5) * 2;
      targetY = (event.clientY / window.innerHeight - 0.5) * 2;
    };
    const leave = () => {
      targetX = 0;
      targetY = 0;
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    const subscription = conductor.subscribe(({ phase, delta }) => {
      const damping = 1 - Math.exp(-delta / 180);
      x += (targetX - x) * damping;
      y += (targetY - y) * damping;
      element.style.setProperty(
        "--conduct-x",
        `${Math.sin(phase * 0.26) * 24 + x * 18}px`,
      );
      element.style.setProperty(
        "--conduct-y",
        `${Math.cos(phase * 0.21) * 18 + y * 12}px`,
      );
      element.style.setProperty(
        "--conduct-rotation",
        `${Math.sin(phase * 0.16) * 2}deg`,
      );
      element.style.setProperty(
        "--conduct-pulse",
        String(0.72 + Math.sin(phase * 0.6) * 0.18),
      );
      element.style.setProperty("--conductor-time", String(phase));
      element.style.setProperty(
        "--ambient-breath",
        String(0.5 + Math.sin(phase * 0.6) * 0.2),
      );
      element.style.setProperty("--conduct-pointer-x", `${x * 8}px`);
      element.style.setProperty("--conduct-pointer-y", `${y * 6}px`);
    });
    return () => {
      subscription.unsubscribe();
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
      for (const name of [
        "--conduct-x",
        "--conduct-y",
        "--conduct-rotation",
        "--conduct-pulse",
        "--conduct-pointer-x",
        "--conduct-pointer-y",
        "--conductor-time",
        "--ambient-breath",
      ])
        element.style.removeProperty(name);
    };
  }, [conductor]);
  return (
    <div className="ambient-score" aria-hidden="true">
      <div className="ambient-orbit ambient-orbit-one" />
      <div className="ambient-orbit ambient-orbit-two" />
      <svg viewBox="0 0 1440 1000" preserveAspectRatio="xMidYMid slice">
        {waves.map((path, index) => (
          <path key={index} d={path} className={"ambient-wave wave-" + index} />
        ))}
      </svg>
    </div>
  );
}

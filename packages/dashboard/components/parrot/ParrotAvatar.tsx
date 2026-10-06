export type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "locked";
export function ParrotAvatar({ state, demo }: { state: AvatarState; demo: boolean }) {
  return (
    <div className={`parrot-avatar parrot-avatar--${state}`}>
      <div className="parrot-portrait">
        <img src="/parrot.jpg" width={524} height={528} alt="PerpParrot, a friendly green clay parrot with googly eyes, an orange beak, rainbow propeller cap and navy Team RT3 hoodie" />
      </div>
      {state === "thinking" && <div className="parrot-dots" aria-hidden="true"><i /><i /><i /></div>}
      {state === "locked" && <span className="parrot-stamp">{demo ? "DEMO PENDING" : "PENDING"}</span>}
      <div className="parrot-nameplate"><span aria-hidden="true">●</span> PERPPARROT <span className="opacity-70">/ TEAM RT3</span></div>
    </div>
  );
}

export type AvatarState = "idle" | "listening" | "thinking" | "speaking";
export function ParrotAvatar({ state }: { state: AvatarState }) {
  return <div className={`parrot-avatar parrot-avatar--${state}`}>
    <div className="parrot-halo" aria-hidden="true"><i /><i /><i /></div>
    <div className="parrot-portrait">
      <img src="/parrot.jpg" width={524} height={528} alt="PerpParrot, a friendly green clay parrot with googly eyes, an orange beak, rainbow propeller cap and navy Team RT3 hoodie" />
    </div>
  </div>;
}

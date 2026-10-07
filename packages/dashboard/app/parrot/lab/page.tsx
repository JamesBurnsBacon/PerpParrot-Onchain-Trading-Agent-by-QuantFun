// Development materials route that loads LabClient only outside production.
// Keep the guarded dynamic import and production 404; no lab code may ship.
import { notFound } from "next/navigation";

export const metadata = { title: "Materials lab", description: "Development-only sound and visual auditions." };
export default async function MaterialsPage() {
  // Keep the import itself behind the constant so webpack removes all lab recipes/client code.
  const mod = process.env.NODE_ENV !== "production" ? await import("./LabClient") : null;
  if (!mod) notFound();
  const LabClient = mod.default;
  return <LabClient />;
}

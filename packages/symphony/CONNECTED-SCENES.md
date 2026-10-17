# Connected scene interaction contract

The hero, signal creature and composition artwork share one decorative state provider inside the existing motion conductor. It owns seed, movement, palette, intensity, reset epoch and a bounded pulse event. Source selection and preview inclusion are read-only inputs from the existing portfolio model.

- Either seed control changes both scenes and the score's contour seed.
- Flow/Allegro maps to Parrot, Flock/Ensemble to Plumage, and Orbit/Adagio to Orbit. Both scene control banks update the same value.
- Solar/Ultraviolet changes creature colors and hero trail colors; tempo affects both simulations.
- Reset restores seed47, Flow/Parrot, Solar and55% intensity, rebuilding both art engines even if defaults are already selected. It preserves equity, source selection and preview inclusion.
- Feed/Scatter emits a monotonically identified pulse with conductor phase. Visible, unpaused scenes respond once. Offscreen and paused scenes discard it; no delayed pulse is queued.
- Both scenes display the same selected source name and original feather identity, together with the active preview count. Excluded fingerprints dim. Selected identity tints the artwork; these colors are decorative and never represent returns.
- Creature pause and hero pause control the existing shared motion gate. Reduced motion still applies.
- In live endpoint mode, art is explicitly a decorative reference, shows no live position count, and does not substitute synthetic values for unavailable data.

Validation: TypeScript passed;43 unit tests passed, including six new reducer/mapping/pulse/identity tests. Runtime interaction, responsive layout and perceived motion require browser inspection; unit tests are not evidence of those visual outcomes.

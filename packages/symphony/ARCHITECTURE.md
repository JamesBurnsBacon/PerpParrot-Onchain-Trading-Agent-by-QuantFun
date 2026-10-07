# PerpParrot application boundary

This application replaces the standalone visual prototype with React and TypeScript modules. The visual identity remains original: a sculptural parrot and seeded flight trails. Decorative trajectories do not encode returns, prediction, or blockchain events.

## Repository roles

- React + Vite: component lifecycle, typed modules and production bundling.
- Motion: coordinated entrance and state transitions, honoring the global pause and reduced-motion preference.
- Radix Dialog: accessible modal primitive with focus containment and restoration.
- TanStack Query: cancellation, asynchronous status, query isolation and refresh for the read-only dashboard adapter.
- Zod: validation at the API boundary; incompatible payloads must surface as errors.
- Lucide: consistent small functional icons.

These are selected tools with distinct responsibilities. Generative artwork combines original Canvas/SVG geometry and native WebGL point drawing with deterministic initialization, bounded storage and explicit teardown. No Three.js dependency is required for this renderer. CPU integration supplies motion; the GPU draws the resulting point positions.

## Data policy

Demo mode is the default and labels all data synthetic. Live mode reads configured backend and executor dashboard routes. Loading, empty, schema failure and network failure must remain visible. Switching to live never silently supplies synthetic fixtures. No signing, wallet authorization, order submission or executor mutation is implemented.

The existing PerpParrot dashboard contracts are the integration reference; this application is isolated from that checkout. Real backend compatibility requires a configured deployment and endpoint responses, not just a successful frontend build.

## Acceptance gates

TypeScript and production build; useful data/motion invariants; rendered desktop and mobile critique; keyboard tabs and modal behavior; search and empty states; live failure separation; console inspection. Record each observed result and each untested limit in the engineering SOP.

## Identity and choreography

`feather-fingerprint.ts` generates seven closed tapered harmonic contours per source ID, plus barbs; identities are stable independently of inclusion. `FeatherIdentity` reuses the geometry in the ledger and inspector. `SignalPlumage` maps source weight to feather size and inclusion to opacity. These shapes identify sources; the adjacent signed paths and text encode exposures.

The shared conductor also drives the three-layer flight rig and damped native-scroll feather unfurling. User-triggered takeoff feedback changes React state at cue start/end only; per-frame transforms stay outside React rendering. Unmount unsubscribes the visual voices, and provider teardown releases the scheduler and listeners.

## Cinematic rendering boundary

`parrot-morph.ts` initializes seeded samples and 3,200 target points for the current stage. Parrot, Plumage and Orbit select original target formations. Damped CPU springs, local pointer repulsion, velocity/position clamps and scatter impulses evolve typed position buffers. Palette updates change the color buffer independently. Invalid allocation counts are rejected; nonfinite timing is ignored and invalid pointer data is normalized.

`point-renderer.ts` draws these buffers using native WebGL, with a Canvas2D fallback. It does not run GPU compute physics or neighbor-based boids. `SignalCreature.tsx` owns resize/intersection observers, pointer listeners, renderer teardown and the conductor subscription. Native viewport position feeds an interpolated camera parameter; scroll remains native. A local still control and global pause/reduced-motion/visibility gates stop continuous work. The panoramic hero retains independently hinged artwork layers.

The 37-test suite includes seeded trajectory and geometry invariants, bounded morphing/pointer behavior, post-scatter settling, independent palettes, adversarial timing/pointer inputs, scheduler cleanup and API/composition boundaries. Browser verification remains necessary for shader compilation, fallback behavior, visible articulation, reduced motion, touch input and realistic device performance. Exact observed checks belong in the engineering SOP.

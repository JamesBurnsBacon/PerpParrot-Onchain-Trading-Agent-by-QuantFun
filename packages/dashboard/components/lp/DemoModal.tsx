"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DemoVideo } from "../../lib/demo-video";

export function DemoModal({ video }: { video: DemoVideo }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="lp-dh-action lp-dh-demo"
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 5 11 7-11 7Z" fill="currentColor" /></svg>
        Demo
      </button>
      {/* No portal: the top-layer dialog remains a descendant of the .lp theme. */}
      <dialog
        ref={dialog}
        className="lp-demo-modal"
        aria-labelledby={titleId}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
            event.currentTarget.close();
          }
        }}
      >
        <div className="lp-demo-heading">
          <h2 id={titleId}>Demo</h2>
          <button type="button" className="lp-demo-close" aria-label="Close demo" autoFocus onClick={() => dialog.current?.close()}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="lp-demo-frame">
          {open && (video.kind === "iframe" ? (
            <iframe
              src={video.src}
              title={video.title}
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : <video src={video.src} controls playsInline />)}
        </div>
      </dialog>
    </>
  );
}

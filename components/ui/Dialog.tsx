"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./Button";
import { IconButton } from "./IconButton";

/**
 * Figma `Dialog` (`16:43`, page `4:29`): `Kind` = Standard | Destructive.
 * Native `<dialog>` opened with `showModal()`, so focus containment, the inert
 * background and Escape are the browser's. Labelled by its title; initial focus
 * lands on Cancel (`autofocus`, honoured by `showModal()`), never on the destructive action; focus returns to the opener
 * on close. The destructive body must state what will be deleted AND what will not.
 */
export interface DialogProps {
  readonly open: boolean;
  /** Called on Escape, the close button and Cancel. The caller sets `open=false`. */
  readonly onClose: () => void;
  readonly kind?: "standard" | "destructive";
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly cancelLabel?: string;
  readonly closeLabel?: string;
}

export function Dialog({
  open,
  onClose,
  kind = "standard",
  title,
  children,
  confirmLabel,
  onConfirm,
  cancelLabel = "Cancel",
  closeLabel = "Close",
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-kind={kind}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-lg border border-line bg-bg-elevated p-6 text-ink shadow-3 backdrop:bg-scrim"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id={titleId} className="text-title-3">
          {title}
        </h2>
        <IconButton kind="quiet" icon="close" label={closeLabel} onClick={onClose} />
      </div>
      <div className="mt-2 text-body text-ink-2">{children}</div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button autoFocus kind="secondary" label={cancelLabel} onClick={onClose} />
        <Button kind={kind === "destructive" ? "danger" : "primary"} label={confirmLabel} onClick={onConfirm} />
      </div>
    </dialog>
  );
}

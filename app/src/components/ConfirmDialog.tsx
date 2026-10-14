import { useEffect, useRef } from "react";
import { AlertCircle, X } from "lucide-react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab" && dialogRef.current) {
        const buttons = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)"));
        if (!buttons.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section ref={dialogRef} className="capture-dialog confirm-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" tabIndex={-1}>
        <div className="panel-heading">
          <div><AlertCircle size={18} /><h2 id="confirm-dialog-title">{title}</h2></div>
          <button className="icon-quiet" onClick={onCancel} aria-label="关闭"><X size={18} /></button>
        </div>
        <p id="confirm-dialog-message">{message}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} className="action-secondary" onClick={onCancel}>取消</button>
          <button className="action-primary danger-confirm" onClick={() => void onConfirm()}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
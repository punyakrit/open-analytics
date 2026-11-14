import { useEffect, useId, useRef, type ReactNode } from 'react';
import { CloseIcon } from './Icons';

/**
 * A dialog over the page. `side` slides a tall panel in from the right (settings); otherwise it is a
 * centred box. Escape and a click outside close it, and focus returns to whatever opened it.
 */
export function Modal({
  open,
  onClose,
  children,
  width = 'max-w-2xl',
  title,
  side = false,
  sheet = false,
  bare = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  title?: ReactNode;
  side?: boolean;
  /** Rise from the bottom as a tall sheet (visitor profiles). */
  sheet?: boolean;
  /** No header or padding: the content lays itself out. */
  bare?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Callers often pass a new function every render; reading it through a ref keeps the effect below
  // from re-running (and moving focus) each time.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // Focus the first field if there is one, else the dialog itself.
    const first = side || sheet ? null : panel.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea');
    (first ?? panel.current)?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className={`fixed inset-0 z-50 flex bg-stone-950/45 ${
        side ? 'justify-end' : sheet ? 'items-end justify-center' : 'items-start justify-center overflow-y-auto p-3 sm:p-6 sm:pt-[9vh]'
      }`}
      onMouseDown={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={
          side
            ? 'oa-slide-in flex h-full w-full max-w-[920px] flex-col overflow-hidden bg-paper shadow-pop outline-none sm:rounded-l-2xl'
            : sheet
              ? 'oa-sheet-in flex h-[92vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-t-2xl bg-paper shadow-pop outline-none sm:h-[86vh]'
              : `oa-pop-in pop w-full ${width} outline-none`
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        {bare ? (
          children
        ) : (
          <>
            {title && (
              <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
                <h2 id={titleId} className="text-[17px] font-semibold tracking-tight">
                  {title}
                </h2>
                <button className="icon-btn -mr-1.5" onClick={onClose} aria-label="Close">
                  <CloseIcon />
                </button>
              </div>
            )}
            <div className="px-5 pb-5 pt-3">{children}</div>
          </>
        )}
      </div>
    </div>
  );
}

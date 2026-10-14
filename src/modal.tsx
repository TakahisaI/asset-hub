import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="help-modal"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const elements = [
          ...e.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, summary, [tabindex]',
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(':disabled') &&
            element.checkVisibility({ visibilityProperty: true }),
        );
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (!elements.length) {
          e.preventDefault();
          e.currentTarget.focus();
        } else if (e.shiftKey && index <= 0) {
          e.preventDefault();
          elements.at(-1)!.focus();
        } else if (!e.shiftKey && (index < 0 || index === elements.length - 1)) {
          e.preventDefault();
          elements[0].focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}

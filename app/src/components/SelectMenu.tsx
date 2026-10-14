import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectMenuProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}

export function SelectMenu({ value, options, onChange, ariaLabel, className = "", disabled = false }: SelectMenuProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, options.findIndex((option) => option.value === value)));
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 240 });

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxHeight = Math.min(260, Math.max(120, window.innerHeight - 32));
    const estimatedHeight = Math.min(maxHeight, options.length * 40 + 8);
    const openAbove = rect.bottom + estimatedHeight + 8 > window.innerHeight;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - rect.width - 8));
    setPosition({
      left,
      top: openAbove ? Math.max(8, rect.top - estimatedHeight - 5) : Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 5),
      width: Math.min(rect.width, window.innerWidth - 16),
      maxHeight
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const onViewportChange = () => updatePosition();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target) && !document.getElementById(id)?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, id, open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  const enabledIndex = (start: number, direction: 1 | -1) => {
    if (!options.length) return 0;
    let index = start;
    for (let count = 0; count < options.length; count += 1) {
      index = (index + direction + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return start;
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const openAt = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAt(Math.max(0, options.findIndex((option) => option.value === value)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(enabledIndex(Math.max(0, options.findIndex((option) => option.value === value)), -1));
    }
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => enabledIndex(index, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => enabledIndex(index, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(options.findIndex((option) => !option.disabled));
    } else if (event.key === "End") {
      event.preventDefault();
      const reversedIndex = [...options].reverse().findIndex((option) => !option.disabled);
      setActiveIndex(reversedIndex < 0 ? 0 : options.length - reversedIndex - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      const focusable = Array.from(document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.closest(".select-menu-popup") && element.getClientRects().length > 0);
      const triggerIndex = triggerRef.current ? focusable.indexOf(triggerRef.current) : -1;
      const next = focusable[triggerIndex + direction];
      close(false);
      requestAnimationFrame(() => (next ?? triggerRef.current)?.focus());
    }
  };

  const selected = options.find((option) => option.value === value);
  const menu = open ? createPortal(
    <div id={id} className="select-menu-popup" role="listbox" aria-label={ariaLabel}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
      onKeyDown={onOptionKeyDown}>
      {options.map((option, index) => (
        <button key={option.value} ref={(element) => { optionRefs.current[index] = element; }}
          type="button" role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          tabIndex={index === activeIndex ? 0 : -1}
          className={'select-menu-option' + (option.value === value ? " selected" : "")}
          disabled={option.disabled} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(index)}>
          <span>{option.label}</span>{option.value === value && <Check size={16} aria-hidden="true" />}
        </button>
      ))}
    </div>,
    document.body
  ) : null;

  return (
    <div className={'select-menu ' + className} ref={wrapperRef}>
      <button ref={triggerRef} type="button" className="select-menu-trigger" role="combobox"
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
        disabled={disabled} onClick={() => open ? close(false) : openAt(Math.max(0, options.findIndex((option) => option.value === value)))}
        onKeyDown={onTriggerKeyDown}>
        <span>{selected?.label ?? value}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
}
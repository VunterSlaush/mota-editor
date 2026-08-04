import { useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

/** One row of the dropdown. Callers map their domain objects onto this. */
export interface PickerOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Second line, shown dimmed under the label. */
  readonly description?: string;
  readonly icon?: ReactNode;
}

interface Props<T extends string> {
  ariaLabel: string;
  options: readonly PickerOption<T>[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
  /** Shown when `value` matches no option (e.g. an unset effort). */
  placeholder?: string;
  /** Which way the panel opens. The composer sits at the bottom. */
  placement?: "top" | "bottom";
  /** Extra class on the trigger, for per-site sizing. */
  className?: string;
}

/**
 * UI — a themed dropdown, replacing the native `<select>` whose popup the
 * OS draws in its own colours and which cannot show an option's
 * description or icon. Follows the BranchPicker's keyboard vocabulary:
 * arrows move, Enter picks, Escape closes.
 */
export function OptionPicker<T extends string>({
  ariaLabel,
  options,
  value,
  disabled,
  onChange,
  placeholder = "",
  placement = "top",
  className = "",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const current = options.find((o) => o.id === value);
  const selectedIndex = options.findIndex((o) => o.id === value);

  // Opening always starts on the current choice.
  useEffect(() => {
    if (open) setHighlighted(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  // A click anywhere else closes the panel.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (option: PickerOption<T>) => {
    if (option.id !== value) onChange(option.id);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setHighlighted((highlighted + delta + options.length) % options.length);
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setHighlighted(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setHighlighted(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) pick(options[highlighted]);
      else setOpen(true);
    }
  };

  return (
    <div className={`picker ${open ? "picker--open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`picker__trigger ${className}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.description ?? current?.label ?? placeholder}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        {current?.icon}
        <span className="picker__label">{current?.label ?? placeholder}</span>
        <CaretDown size={12} className="picker__caret" />
      </button>
      {open && (
        <div
          className={`picker__panel picker__panel--${placement}`}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {options.map((option, index) => (
            <div
              key={option.id}
              role="option"
              aria-selected={option.id === value}
              className={`picker__option ${
                index === highlighted ? "picker__option--highlighted" : ""
              }`}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => pick(option)}
            >
              {option.icon && <span className="picker__option-icon">{option.icon}</span>}
              <span className="picker__option-text">
                <span className="picker__option-label">{option.label}</span>
                {option.description && (
                  <span className="picker__option-description">{option.description}</span>
                )}
              </span>
              {option.id === value && <Check size={14} className="picker__option-check" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

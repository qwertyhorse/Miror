import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import "./SelectionControls.css";

export type SelectionOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

/** Select-only combobox: focus stays on the trigger while arrows explore the list. */
export function CustomSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  prefix,
  placeholder = "请选择",
  indicator = <ChevronDown size={14} aria-hidden="true" />,
}: {
  label: string;
  value: string;
  options: readonly SelectionOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  prefix?: ReactNode;
  placeholder?: string;
  indicator?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const query = useRef({ text: "", at: 0 });
  const selected = options.find((option) => option.value === value);
  const enabled = options
    .map((option, index) => (!option.disabled ? index : -1))
    .filter((index) => index >= 0);
  const current = () => {
    const index = options.findIndex(
      (option) => option.value === value && !option.disabled,
    );
    return index >= 0 ? index : (enabled[0] ?? 0);
  };
  const show = (last = false) => {
    if (disabled || !enabled.length) return;
    setActive(last ? enabled[enabled.length - 1] : current());
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (disabled || !option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };

  useLayoutEffect(() => {
    const popup = list.current;
    const button = trigger.current;
    if (!open || !popup || !button) return;
    const position = () => {
      const bounds = button.getBoundingClientRect();
      const gap = 6;
      const availableBelow = window.innerHeight - bounds.bottom - gap - 12;
      const availableAbove = bounds.top - gap - 12;
      const above = availableBelow < 160 && availableAbove > availableBelow;
      const maxHeight = Math.max(
        60,
        Math.min(280, above ? availableAbove : availableBelow),
      );
      const width = Math.min(
        Math.max(bounds.width, 160),
        window.innerWidth - 24,
      );
      const left = Math.max(
        12,
        Math.min(bounds.left, window.innerWidth - width - 12),
      );
      popup.style.width = `${width}px`;
      popup.style.maxHeight = `${maxHeight}px`;
      popup.style.left = `${left}px`;
      popup.style.top = `${above ? Math.max(12, bounds.top - gap - popup.offsetHeight) : bounds.bottom + gap}px`;
    };
    // Popover places custom options above clipping panels and inside the dialog top layer.
    popup.showPopover?.();
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (open)
      list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!open) {
          show(event.key === "ArrowUp" && !selected);
          return;
        }
        const at = enabled.indexOf(active);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(enabled[(at + step + enabled.length) % enabled.length] ?? 0);
        return;
      }
      case "Home":
      case "End":
        event.preventDefault();
        if (!open) setOpen(true);
        setActive(
          event.key === "Home"
            ? (enabled[0] ?? 0)
            : (enabled[enabled.length - 1] ?? 0),
        );
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(active);
        else show();
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
        return;
      case "Tab":
        setOpen(false);
        return;
    }
    if (
      event.key.length !== 1 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    event.preventDefault();
    const now = Date.now();
    const text =
      (now - query.current.at < 650 ? query.current.text : "") +
      event.key.toLocaleLowerCase();
    query.current = { text, at: now };
    const start = open ? active : current();
    const order = [
      ...enabled.filter((index) => index > start),
      ...enabled.filter((index) => index <= start),
    ];
    const next = order.find((index) =>
      options[index].label.toLocaleLowerCase().startsWith(text),
    );
    if (next !== undefined) {
      setActive(next);
      setOpen(true);
    }
  };

  return (
    <div ref={root} className={`custom-select ${className}`}>
      <button
        ref={trigger}
        type="button"
        className="custom-select-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        data-value={value}
        disabled={disabled || !enabled.length}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        {prefix}
        <span>{selected?.label ?? placeholder}</span>
        {indicator}
      </button>
      {open && (
        <div
          ref={list}
          id={`${id}-list`}
          popover="manual"
          className="custom-select-list"
          role="listbox"
          aria-label={label}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={`custom-select-option ${active === index ? "active" : ""}`}
              data-value={option.value}
              onPointerMove={() => !option.disabled && setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CustomCheckbox({
  checked,
  onChange,
  disabled = false,
  children,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`custom-selection-checkbox ${className}`}>
      <span className="custom-selection-mark">
        <input
          className="custom-selection-input"
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <Check
          size={12}
          className="custom-selection-check"
          aria-hidden="true"
        />
      </span>
      <span>{children}</span>
    </label>
  );
}

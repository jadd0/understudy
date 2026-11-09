/**
 * An on/off control that submits its form: the button flips the value, the server stores it. `name` carries
 * the NEW value ("on" / "off") so a plain form action needs no client script.
 */
export function Switch({ on, name, label, disabled = false }: { on: boolean; name: string; label: string; disabled?: boolean }) {
  return (
    <button
      type="submit"
      name={name}
      value={on ? "off" : "on"}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-accent" : "bg-line-focus"}`}
    >
      <span className={`inline-block h-6 w-6 rounded-full bg-ground transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

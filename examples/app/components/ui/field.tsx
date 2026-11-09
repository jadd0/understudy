import type { InputHTMLAttributes, ReactNode } from "react";

/** Labelled text field in the design's search-field style (surface fill, 12px radius, 44px tall). */
export function Field({
  label,
  hint,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; id: string }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      <input
        id={id}
        className="h-11 rounded-field border border-transparent bg-surface px-3 text-[15px] outline-none placeholder:text-muted focus:border-line-focus focus:bg-ground"
        {...rest}
      />
      {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-field bg-[#FDECEC] px-3 py-2 text-[14px] text-danger">
      {children}
    </p>
  );
}

/** The centred single-column frame used by sign-in, onboarding and other one-task screens. */
export function SoloPage({ title, lead, children }: { title: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[400px] flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-muted">Understudy</span>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{title}</h1>
        {lead ? <p className="text-[15px] leading-relaxed text-muted-2">{lead}</p> : null}
      </div>
      {children}
    </main>
  );
}

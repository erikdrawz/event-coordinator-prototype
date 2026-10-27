import { useId, type ReactNode } from 'react';
import './form.css';

/** A titled group of fields inside a form. */
export function FormSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <fieldset className="form-section">
      {title && <legend className="form-section-title">{title}</legend>}
      <div className="form-grid">{children}</div>
    </fieldset>
  );
}

interface FieldProps {
  label: string;
  required?: boolean;
  hint?: string | null;
  error?: string | null;
  /** Span both grid columns. */
  wide?: boolean;
  /** Renders the control; wire `id` to it so the label is attached. */
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** Label + control + hint/error. Inputs use the shared `.input` class. */
export function Field({ label, required, hint, error, wide, children }: FieldProps) {
  const id = useId();
  const noteId = hint || error ? `${id}-note` : undefined;
  return (
    <div className={`field${wide ? ' field-wide' : ''}${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id} className="field-label">{label}{required && <span className="field-required" aria-hidden> *</span>}</label>
      {children(id, noteId)}
      {(error || hint) && <div id={noteId} className={error ? 'field-error' : 'field-hint'}>{error ?? hint}</div>}
    </div>
  );
}

/** A checkbox with its label to the right, for yes/no fields. */
export function CheckboxField({ label, checked, onChange, hint, wide, disabled }:
  { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string | null; wide?: boolean; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={`field field-check${wide ? ' field-wide' : ''}`}>
      <label htmlFor={id} className="check">
        <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/** Toggleable chips for picking several values from a short list. */
export function ChipPicker({ options, value, onChange, label }:
  { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button key={o.value} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

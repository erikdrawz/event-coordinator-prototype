import { CheckboxField, ChipPicker, Field } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { DateInput } from '../../ui/DateInput';
import type { CustomFieldDef, UserOpt } from './eventForm';

interface Props {
  def: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  users: UserOpt[];
}

/** Renders one admin-defined field from its definition. */
export function CustomFieldInput({ def, value, onChange, error, users }: Props) {
  if (def.field_type === 'checkbox') {
    return <CheckboxField label={def.label} checked={value === true} onChange={onChange} hint={def.help_text} wide />;
  }
  const wide = def.field_type === 'long_text' || def.field_type === 'multi_picklist';
  return (
    <Field label={def.label} required={def.is_required} hint={def.help_text} error={error} wide={wide}>
      {(id, describedBy) => {
        const common = { id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) || undefined, className: 'input' };
        switch (def.field_type) {
          case 'long_text':
            return <textarea {...common} rows={3} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
          case 'number':
          case 'currency':
            return <input {...common} type="number" step={def.decimals != null ? 10 ** -def.decimals : 'any'} value={value == null ? '' : String(value)}
              onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
          case 'date':
            return <DateInput id={id} aria-describedby={describedBy} aria-invalid={Boolean(error) || undefined}
              value={(value as string) ?? ''} onChange={(v) => onChange(v || null)} />;
          case 'picklist':
            return (
              <Select id={id} aria-describedby={describedBy} aria-invalid={Boolean(error) || undefined}
                value={(value as string) ?? ''} onChange={(v) => onChange(v || null)} options={def.options}
                emptyLabel={def.is_required ? undefined : 'None'} />
            );
          case 'multi_picklist':
            return <ChipPicker label={def.label} options={def.options} value={(value as string[]) ?? []} onChange={onChange} />;
          case 'lookup_user':
            return (
              <Select id={id} aria-describedby={describedBy} aria-invalid={Boolean(error) || undefined} searchable
                value={(value as string) ?? ''} onChange={(v) => onChange(v || null)} emptyLabel={def.is_required ? undefined : 'None'}
                options={users.map((u) => ({ value: u.id, label: u.display_name }))} />
            );
          case 'url':
            return <input {...common} type="url" inputMode="url" placeholder="https://" value={(value as string) ?? ''}
              onChange={(e) => onChange(e.target.value.trim())} />;
          default:
            return <input {...common} type="text" maxLength={255} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
        }
      }}
    </Field>
  );
}

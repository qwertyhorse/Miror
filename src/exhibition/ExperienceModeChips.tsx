import { useId } from 'react';
import { Check } from 'lucide-react';
import { EXHIBITION_EXPERIENCE_MODES, EXHIBITION_MODE_LABELS, type ExhibitionExperienceMode } from '../../shared/exhibition';

export function experienceModeLabel(mode: ExhibitionExperienceMode) { return EXHIBITION_MODE_LABELS[mode]; }

/** Native radios keep the compact chips single-select and keyboard accessible. */
export function ExperienceModeChips({ value, onChange, label, disabled = false }: {
  value: ExhibitionExperienceMode; onChange: (mode: ExhibitionExperienceMode) => void; label: string; disabled?: boolean;
}) {
  const name = useId();
  return <fieldset className="ex-mode-choices" disabled={disabled}>
    <legend>{label}</legend>
    <div className="ex-mode-chips">{EXHIBITION_EXPERIENCE_MODES.map(mode => <label key={mode}>
      <input type="radio" name={name} value={mode} checked={value === mode} onChange={() => onChange(mode)} />
      <span>{value === mode && <Check size={12} aria-hidden="true" />}{experienceModeLabel(mode)}</span>
    </label>)}</div>
  </fieldset>;
}

import { comparisonProviders } from "../../../../config/comparison";

export function ProviderSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label>Provider
    <select value={value} onChange={event => onChange(event.target.value)}>
      {Object.entries(comparisonProviders).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
  </label>;
}

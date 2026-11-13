import { comparisonProviders } from "../../../../config/comparison";

// Hidden while only one comparison provider is configured.
export function ProviderSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const providers = Object.entries(comparisonProviders);
  if (providers.length < 2) return null;
  return <select aria-label="Comparison provider" value={value} onChange={event => onChange(event.target.value)}>
    {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
  </select>;
}

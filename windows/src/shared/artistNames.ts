export function artistNameKey(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr')
    .replace(/\s*&\s*|\bet\b/gu, ' & ').replace(/\s+/g, ' ').trim();
}

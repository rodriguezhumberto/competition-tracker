/** Local builds can omit HTTPS hosting; deployable container builds must supply it. */
export function productionHostname(
  value: string | undefined,
  required = false,
): string | undefined {
  if (!value) {
    if (required) throw new Error('PRODUCTION_HOSTNAME is required for production Docker builds.');
    return undefined;
  }
  if (
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      value,
    )
  )
    throw new Error('PRODUCTION_HOSTNAME must be a DNS hostname without a scheme, port, or path.');
  const hostname = value.toLowerCase();
  if (
    /(?:^|\.)example\.(?:com|net|org)$/.test(hostname) ||
    /(?:^|\.)(?:localhost|invalid|test|example)$/.test(hostname) ||
    /^\d+(?:\.\d+){3}$/.test(hostname)
  )
    throw new Error(
      'PRODUCTION_HOSTNAME must be a real production DNS hostname, not a placeholder.',
    );
  return hostname;
}

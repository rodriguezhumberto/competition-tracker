import { ensure, label } from './validation.ts';

export interface TrackedItem {
  code: string;
  name: string;
}

export function itemCode(value: unknown): string {
  ensure(
    typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._\/-]{0,79}$/u.test(value.trim()),
    'Report code must contain 1–80 letters, numbers, spaces or . _ / - characters.',
  );
  return value.trim();
}

export function validateItems(raw: unknown): TrackedItem[] {
  let items = raw;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      ensure(false, 'Tracked items must be a valid list.');
    }
  }
  ensure(
    Array.isArray(items) && items.length > 0 && items.length <= 100,
    'Include 1–100 tracked items.',
  );
  const validated = items.map((item: unknown) => {
    ensure(item && typeof item === 'object' && !Array.isArray(item), 'Invalid tracked item.');
    const value = item as Record<string, unknown>;
    return { code: itemCode(value.code), name: label(value.name, 'Item name') };
  });
  ensure(
    new Set(validated.map((item) => item.code)).size === validated.length,
    'Each tracked item must have a unique report code.',
  );
  return validated;
}

export function itemConfiguration(input: Record<string, unknown>) {
  const multiple_items = input.multiple_items === true || input.multiple_items === 'on';
  const item_label = label(input.item_label || 'Item', 'Item label');
  const items = multiple_items ? validateItems(input.items) : [];
  return { multiple_items, item_label, tracked_items: JSON.stringify(items) };
}

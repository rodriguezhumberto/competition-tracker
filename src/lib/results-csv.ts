import { centralReportTime } from './central-time.ts';
import type { leaderboard } from './competition-store.ts';

function textCell(value: string): string {
  // Treat user-defined labels and identifiers as text in spreadsheet apps.
  const safe = /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function resultsCsv(board: ReturnType<typeof leaderboard>): string {
  const header = [
    'Rank',
    ...(board.multipleItems ? [board.itemLabel] : []),
    board.identifierLabel,
    ...board.metrics.map((metric) =>
      metric.type === 'currency' ? `${metric.label} (${metric.currency})` : metric.label,
    ),
    'Updated (America/Chicago — CST/CDT)',
  ]
    .map(textCell)
    .join(',');
  const rows = board.rows.map((row) =>
    [
      row.rank ?? '',
      ...(board.multipleItems
        ? [
            textCell(
              board.selectedItem
                ? board.items.find((item) => item.code === board.selectedItem)!.name
                : 'All items',
            ),
          ]
        : []),
      textCell(row.operatorNumber),
      ...board.metrics.map((metric) => row.values[metric.key] ?? ''),
      textCell(centralReportTime(row.updated)),
    ].join(','),
  );
  // A UTF-8 BOM lets Excel recognize Unicode; CRLF is the CSV record separator.
  return `\uFEFF${[header, ...rows].join('\r\n')}\r\n`;
}

export function resultsFilename(board: ReturnType<typeof leaderboard>): string {
  const name =
    board.competition.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'competition';
  const item = board.selectedItem
    ? `-${board.selectedItem.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80)}`
    : '';
  return `${name}${item}-${board.competition.id}-${board.period}-${board.selected.key}-results.csv`;
}

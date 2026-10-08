import { itemFilterErrorResponse } from '../../lib/leaderboard.ts';
import type { APIRoute } from 'astro';
import { isAdmin } from '../../lib/auth.ts';
import { getCompetition, leaderboard } from '../../lib/competition-store.ts';
import { resultsCsv, resultsFilename } from '../../lib/results-csv.ts';

export const GET: APIRoute = ({ cookies, url }) => {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!isAdmin(cookies)) return new Response('Unauthorized.', { status: 403, headers });
  const id = Number(url.searchParams.get('competition_id'));
  if (!Number.isSafeInteger(id) || id <= 0)
    return new Response('Competition not found.', { status: 404, headers });
  let competition;
  try {
    competition = getCompetition(id);
  } catch {
    return new Response('Competition not found.', { status: 404, headers });
  }
  let board;
  try {
    board = leaderboard(id, {
      competition,
      audience: 'admin',
      metric: url.searchParams.get('metric'),
      period: url.searchParams.get('period'),
      item: url.searchParams.get('item'),
    });
  } catch (error) {
    const response = itemFilterErrorResponse(error, url);
    if (response) return response;
    throw error;
  }

  return new Response(resultsCsv(board), {
    headers: {
      ...headers,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${resultsFilename(board)}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
};

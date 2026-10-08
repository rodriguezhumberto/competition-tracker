import { destroyCompactStandings, initCompactStandings } from './compact-standings-client.ts';
// Refresh only the board using its server-rendered, audience-filtered markup.
// The surrounding page (including Power Hour state) stays mounted.
const requests = new WeakMap<HTMLElement, AbortController>();
const minimumHeights = new WeakMap<HTMLElement, string>();

function releaseHeight(board: HTMLElement) {
  const original = minimumHeights.get(board);
  if (original !== undefined) board.style.minHeight = original;
  minimumHeights.delete(board);
}

async function updateBoard(board: HTMLElement, url: URL) {
  requests.get(board)?.abort();
  const controller = new AbortController();
  requests.set(board, controller);
  board.setAttribute('aria-busy', 'true');
  const error = board.querySelector<HTMLElement>('.board-error');
  if (error) error.hidden = true;
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok || response.redirected)
      throw new Error('Unable to update standings. Please try again.');
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    const next = document.querySelector<HTMLElement>('[data-competition-board]');
    if (!next) throw new Error('Standings are unavailable. Please try again.');
    if (controller.signal.aborted) return;

    const { scrollX, scrollY } = window;
    const focused = window.document.activeElement;
    const focusedName =
      focused instanceof HTMLSelectElement && board.contains(focused) ? focused.name : null;
    // Keep the document tall while Alpine initializes the responsive chart.
    if (!minimumHeights.has(board)) minimumHeights.set(board, board.style.minHeight);
    board.style.minHeight = `${board.getBoundingClientRect().height}px`;
    destroyCompactStandings(board);
    board.replaceChildren(...next.childNodes);
    history.replaceState(history.state, '', url);
    if (focusedName)
      board
        .querySelector<HTMLSelectElement>(`select[name="${focusedName}"]`)
        ?.focus({ preventScroll: true });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (requests.get(board) !== controller) return;
        const stillAtPosition = window.scrollY === scrollY;
        releaseHeight(board);
        // Do not interrupt scrolling or a newer selection during initialization.
        if (stillAtPosition) window.scrollTo(scrollX, scrollY);
        initCompactStandings(board);
      }),
    );
  } catch (cause) {
    if (controller.signal.aborted) return;
    releaseHeight(board);
    if (error) {
      error.textContent =
        cause instanceof Error ? cause.message : 'Unable to update standings. Please try again.';
      error.hidden = false;
    }
  } finally {
    if (requests.get(board) === controller) board.removeAttribute('aria-busy');
  }
}

function submitView(form: HTMLFormElement) {
  const board = form.closest<HTMLElement>('[data-competition-board]');
  if (!board) return;
  const url = new URL(form.action, location.href);
  for (const [key, value] of new FormData(form)) url.searchParams.set(key, String(value));
  void updateBoard(board, url);
}

document.addEventListener('change', (event) => {
  const form = (event.target as Element).closest<HTMLFormElement>(
    '.board-controls, .compact-controls',
  );
  if (form) submitView(form);
});
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form instanceof HTMLFormElement && form.matches('.board-controls, .compact-controls')) {
    event.preventDefault();
    submitView(form);
  }
});
document.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-board-link]');
  const board = link?.closest<HTMLElement>('[data-competition-board]');
  if (!link || !board) return;
  event.preventDefault();
  void updateBoard(board, new URL(link.href));
});

const controllers = new WeakMap<HTMLElement, () => void>();

export function destroyCompactStandings(scope: ParentNode) {
  scope
    .querySelectorAll<HTMLElement>('[data-compact-standings]')
    .forEach((root) => controllers.get(root)?.());
}

export function initCompactStandings(scope: ParentNode = document) {
  scope.querySelectorAll<HTMLElement>('[data-compact-standings]').forEach((root) => {
    if (controllers.has(root)) return;
    let active = true;
    const chart = root.querySelector<HTMLElement>('.compact-vertical-chart');
    const columns = Array.from(root.querySelectorAll<HTMLElement>('.compact-column'));
    const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>('tbody tr'));
    const overflow = root.querySelector<HTMLElement>('.compact-overflow')!;
    const button = root.querySelector<HTMLButtonElement>('.overflow-toggle')!;
    const activity = root.closest('.compact-grid')?.querySelector<HTMLElement>('.compact-activity');
    const updates = Array.from(activity?.querySelectorAll<HTMLElement>('.compact-update') ?? []);
    let expanded = false;
    let remaining = 0;
    let frame = 0;
    let chartWidth = -1;
    const updateButton = () => {
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = `${expanded ? 'Hide' : 'Show'} ${remaining} more ${remaining === 1 ? 'competitor' : 'competitors'} ${expanded ? '↑' : '↓'}`;
    };
    const updateMoves = () => {
      if (!activity || !updates.length) return;
      if (window.matchMedia('(max-width:760px)').matches) {
        updates.forEach((update, index) => (update.hidden = index >= 4));
        activity.dataset.allMovesShown = String(updates.length <= 4);
        return;
      }
      const headingHeight = activity.querySelector<HTMLElement>('.activity-heading')!.offsetHeight;
      const historyHeight =
        activity.querySelector<HTMLElement>('.activity-history')?.offsetHeight ?? 0;
      const availableHeight = activity.clientHeight - headingHeight - historyHeight;
      // Measure compact rows individually so hidden reports cannot enlarge the card.
      activity.dataset.allMovesShown = 'false';
      updates.forEach((update) => (update.hidden = true));
      let usedHeight = 0;
      let visible = 0;
      for (const update of updates) {
        update.hidden = false;
        const height = update.getBoundingClientRect().height;
        update.hidden = true;
        if (visible > 0 && usedHeight + height > availableHeight + 0.5) break;
        usedHeight += height;
        visible++;
      }
      updates.forEach((update, index) => (update.hidden = index >= visible));
      // Spread out rows only after every available report has been displayed.
      activity.dataset.allMovesShown = String(visible === updates.length);
    };
    const layout = () => {
      if (!active || !root.isConnected || !root.getClientRects().length) return;
      // Keep the initial height independent of how many activity reports exist.
      updates.forEach((update, index) => (update.hidden = index >= 4));
      if (activity) activity.dataset.allMovesShown = 'true';
      const styles = chart ? getComputedStyle(chart) : null;
      const columnWidth = styles ? parseFloat(styles.getPropertyValue('--column-width')) : 0;
      const gap = styles ? parseFloat(styles.columnGap) : 0;
      const capacity = chart
        ? Math.max(1, Math.floor((chart.clientWidth + gap) / (columnWidth + gap)))
        : 0;
      columns.forEach((column, index) => (column.hidden = index >= capacity));
      rows.forEach(
        (row) =>
          (row.hidden =
            row.dataset.chartIndex !== undefined && Number(row.dataset.chartIndex) < capacity),
      );
      remaining = rows.filter((row) => !row.hidden).length;
      // Start with a readable chart, then use the remaining viewport height for taller bars.
      const minimumTrack = window.matchMedia('(min-width:761px)').matches
        ? Math.min(150, Math.max(70, window.innerHeight - 630))
        : 150;
      root.style.setProperty('--track-height', `${minimumTrack}px`);
      button.hidden = true;
      overflow.hidden = remaining === 0;
      const footer = document.querySelector('body > footer')!;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const fits = footer.getBoundingClientRect().bottom + window.scrollY <= viewportHeight;
      button.hidden = remaining === 0 || fits;
      overflow.hidden = remaining === 0 || (!fits && !expanded);
      if (!remaining) expanded = false;
      updateButton();
      if (chart && window.matchMedia('(min-width:761px)').matches) {
        const grid = root.closest<HTMLElement>('.compact-grid')!;
        const board = root.closest<HTMLElement>('.compact-rankings')!;
        // Stretch the chart to fill the available dashboard area, including any height
        // already required by the activity card. Explicit expansion can grow the page.
        const extra = Math.max(
          0,
          viewportHeight - (footer.getBoundingClientRect().bottom + window.scrollY),
        );
        const targetHeight = grid.getBoundingClientRect().height + extra;
        // Grid items stretch by default, so measure the board's actual content.
        const contentHeight = Array.from(board.children).reduce((height, child) => {
          const rect = child.getBoundingClientRect();
          const styles = getComputedStyle(child);
          return (
            height + rect.height + parseFloat(styles.marginTop) + parseFloat(styles.marginBottom)
          );
        }, 2);
        root.style.setProperty(
          '--track-height',
          `${minimumTrack + Math.max(0, targetHeight - contentHeight)}px`,
        );
      }
      updateMoves();
    };
    const schedule = () => {
      if (!active) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    const toggle = () => {
      expanded = !expanded;
      overflow.hidden = !expanded;
      updateButton();
      updateMoves();
    };
    button.addEventListener('click', toggle);
    const observer = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - chartWidth) < 1) return;
      chartWidth = entry.contentRect.width;
      schedule();
    });
    if (chart) observer.observe(chart);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    document.fonts.ready.then(schedule);
    controllers.set(root, () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      button.removeEventListener('click', toggle);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      controllers.delete(root);
    });
    schedule();
  });
}

/**
 * The score sheet's comparison with the agent, as Plump has it. Each finished round's
 * points carry V, the seat's centered reward (its points against the others' mean, what
 * the agents train on), and an "AI" badge: the same deal replayed with the agent's best
 * move in every seat, so a person can see what the agent would have scored in their seat.
 *
 * A game starts a replay when it deals (`startReplay`), keeps the record with the round's
 * history, and draws the cells with `valueCell`, `aiBadge` and `aiTotals`. Records are
 * plain data, so a host can send them to its guests with the rest of the history.
 */

/** V: the seat's points against the others' mean; `lower` where fewer points are better. */
export function centered(points, seat, lower = false) {
  if (!points?.length) return 0;
  const others = points.filter((_, s) => s !== seat);
  if (!others.length) return 0;
  const gap = points[seat] - others.reduce((sum, p) => sum + p, 0) / others.length;
  return lower ? -gap : gap;
}

export function formatValue(value) {
  const rounded = Math.round(value * 10) / 10;
  if (rounded > 0) return `+${rounded.toFixed(1)}`;
  if (rounded < 0) return `−${Math.abs(rounded).toFixed(1)}`;
  return '0.0';
}

/** A score cell's content: the points, and V under them. */
export const valueCell = (score, value) =>
  `<span class="score-cell-value"><strong>${score}</strong><small>V ${formatValue(value)}</small></span>`;

const PENDING = '<span class="score-ai is-pending" title="The agent is replaying this deal"><strong>AI …</strong><small>V …</small></span>';
const UNAVAILABLE = '<span class="score-ai is-unavailable" title="No replay by the agent"><strong>AI —</strong><small>V —</small></span>';

/**
 * The agent's points in `seat` in a replay record ({ status, points }), with V. `format`
 * writes the points as the sheet does; `what` says what the record covers.
 */
export function aiBadge(record, seat, { format = String, lower = false, what = 'this deal' } = {}) {
  if (!record) return '';
  if (record.status === 'pending') return PENDING;
  if (record.status !== 'complete') return UNAVAILABLE;
  const score = format(record.points[seat]), value = formatValue(centered(record.points, seat, lower));
  return `<span class="score-ai" title="The agent, playing every seat at its best, scored ${score} in this seat for ${what} (V ${value})"><strong>AI ${score}</strong><small>V ${value}</small></span>`;
}

/** The replays' totals as one record: pending while any is, unavailable if any failed. */
export function aiTotals(records, players) {
  if (!records.length) return null;
  if (records.some(r => r?.status === 'pending')) return { status: 'pending' };
  if (records.some(r => r?.status !== 'complete')) return { status: 'unavailable' };
  const points = Array(players).fill(0);
  for (const r of records) r.points.forEach((p, seat) => { points[seat] += p; });
  return { status: 'complete', points };
}

/**
 * Starts a replay: `play` resolves to every seat's points, or null once its game is gone.
 * Returns the record, filled in when it settles; then `done(record)` (to redraw the sheet).
 */
export function startReplay(play, done) {
  const record = { status: 'pending', points: null };
  Promise.resolve()
    .then(play)
    .then(
      points => { record.status = points ? 'complete' : 'cancelled'; record.points = points ?? null; },
      error => { record.status = 'unavailable'; console.error('The agent could not replay the deal.', error); },
    )
    .then(() => done(record));
  return record;
}

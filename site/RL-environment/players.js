// Who sits at the tables, the same in every game: the computer players' names,
// given in order to a table's computer seats (its first is always Fern), and
// your name for multiplayer tables, remembered across the games.
export const AI_NAMES = ['Fern', 'Clover', 'Sage', 'Ivy'];

const NAME_KEY = 'player-name';
// Each game used to keep its own; a name saved there still counts.
const OLD_NAME_KEYS = ['hjarter-player-name', 'piquet-player-name', 'rummy-player-name', 'plump-player-name'];

export function savedPlayerName() {
  try {
    for (const key of [NAME_KEY, ...OLD_NAME_KEYS]) {
      const name = localStorage.getItem(key);
      if (name) return name;
    }
  } catch {}
  return '';
}

export function savePlayerName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch {}
}

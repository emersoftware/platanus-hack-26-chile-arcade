-- One row per entry on a board. mode 1 = one pilot (game key '2075.top'),
-- mode 2 = two pilots (game key '2075.top2').
CREATE TABLE scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode INTEGER NOT NULL CHECK (mode IN (1, 2)),
  initials TEXT NOT NULL CHECK (length(initials) = 3 AND initials NOT GLOB '*[^A-Z]*'),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 9999999),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- The game re-sends its whole table on every save: an exact repeat is the same entry.
  UNIQUE (mode, initials, score)
);

-- Ranking order: best score first, then the earlier entry.
CREATE INDEX scores_rank ON scores (mode, score DESC, id);

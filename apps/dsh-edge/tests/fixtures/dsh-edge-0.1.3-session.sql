PRAGMA foreign_keys = ON;

CREATE TABLE dsh_session_persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  store_id TEXT NOT NULL
) STRICT;

CREATE TABLE dsh_sessions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  cwd TEXT,
  parent_session TEXT,
  seed_length INTEGER,
  origin TEXT,
  delegation_depth INTEGER,
  agent_preset TEXT,
  incarnation TEXT NOT NULL,
  revision INTEGER NOT NULL
) STRICT;

CREATE TABLE dsh_session_events (
  session_id TEXT NOT NULL REFERENCES dsh_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  time INTEGER NOT NULL,
  data TEXT NOT NULL,
  source_event_seqs TEXT,
  surface_op TEXT,
  ignorable INTEGER,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE TABLE dsh_edge_blank_sessions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  cwd TEXT,
  parent_session TEXT,
  seed_length INTEGER,
  origin TEXT,
  delegation_depth INTEGER,
  agent_preset TEXT
) STRICT;

INSERT INTO dsh_session_persistence_state (singleton, schema_version, store_id)
VALUES (1, 2, 'fixture-store-v0-1-3');

INSERT INTO dsh_sessions (
  id, version, created_at, cwd, parent_session, seed_length, origin,
  delegation_depth, agent_preset, incarnation, revision
) VALUES (
  'session-v0-1-3', 0, 1000, '/workspace', NULL, NULL, NULL,
  NULL, 'dsh-edge', 'fixture-incarnation-v0-1-3', 7
);

INSERT INTO dsh_session_events (
  session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable
) VALUES
  (
    'session-v0-1-3', 0, 'session/title', 1001,
    '{"title":"DSH Edge 0.1.3 fixture","messageSeqs":[2,4],"source":{"kind":"user"}}',
    NULL, NULL, NULL
  ),
  ('session-v0-1-3', 1, 'turn/start', 1002, '{"turn":1}', NULL, NULL, NULL),
  (
    'session-v0-1-3', 2, 'user/message', 1003,
    '{"id":"fixture-user-message","role":"user","content":[{"type":"text","text":"fixture prompt"}],"source":{"kind":"user"}}',
    NULL, '"append"', NULL
  ),
  ('session-v0-1-3', 3, 'step/start', 1004, '{"turn":1,"step":1}', NULL, NULL, NULL),
  (
    'session-v0-1-3', 4, 'assistant/message', 1005,
    '{"turn":1,"step":1,"message":{"id":"fixture-assistant-message","role":"assistant","content":[{"type":"text","text":"fixture response"}],"source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"}}}',
    NULL, '"append"', NULL
  ),
  ('session-v0-1-3', 5, 'step/end', 1006, '{"turn":1,"step":1}', NULL, NULL, NULL),
  (
    'session-v0-1-3', 6, 'turn/end', 1007,
    '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, NULL
  );

INSERT INTO dsh_edge_blank_sessions (
  id, version, created_at, cwd, parent_session, seed_length, origin,
  delegation_depth, agent_preset
) VALUES (
  'session-v0-1-3-blank', 0, 1008, '/workspace', NULL, NULL, NULL, NULL, 'dsh-edge'
);

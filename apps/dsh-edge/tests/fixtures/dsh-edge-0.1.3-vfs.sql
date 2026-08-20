-- Captured from the dsh-edge 0.1.3 runtime with @cloudflare/computer 0.2.0.
-- Keep this immutable: later runtimes must read and extend this released state.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS _vfs_fetch_cursor;
DROP TABLE IF EXISTS _vfs_mounts;
DROP TABLE IF EXISTS _vfs_watermark;
DROP TABLE IF EXISTS vfs_blob_bytes;
DROP TABLE IF EXISTS vfs_blobs;
DROP TABLE IF EXISTS vfs_changes;
DROP TABLE IF EXISTS vfs_chunks;
DROP TABLE IF EXISTS vfs_dirents;
DROP TABLE IF EXISTS vfs_manifests;
DROP TABLE IF EXISTS vfs_meta;
DROP TABLE IF EXISTS vfs_nodes;

PRAGMA foreign_keys = ON;

CREATE TABLE _vfs_fetch_cursor (
  k TEXT NOT NULL CHECK(k = 'fetch'),
  backend TEXT NOT NULL DEFAULT 'default',
  path TEXT,
  PRIMARY KEY (k, backend)
);

CREATE TABLE _vfs_mounts (
  root TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'read-only'
    CHECK(mode IN ('read-only', 'read-write'))
);

CREATE TABLE _vfs_watermark (
  k TEXT NOT NULL,
  backend TEXT NOT NULL DEFAULT 'default',
  v INTEGER NOT NULL,
  PRIMARY KEY (k, backend)
);

CREATE TABLE vfs_blobs (
  hash BLOB PRIMARY KEY,
  size INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE vfs_blob_bytes (
  hash BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
  bytes BLOB NOT NULL
);

CREATE TABLE vfs_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rev INTEGER NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('delete'))
);

CREATE TABLE vfs_chunks (
  inode INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  hash BLOB NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (inode, idx)
) WITHOUT ROWID;

CREATE TABLE vfs_dirents (
  parent_inode INTEGER NOT NULL,
  name TEXT NOT NULL,
  child_inode INTEGER NOT NULL,
  PRIMARY KEY (parent_inode, name)
) WITHOUT ROWID;

CREATE TABLE vfs_manifests (
  hash BLOB PRIMARY KEY,
  size INTEGER NOT NULL,
  encoded BLOB NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE vfs_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);

CREATE TABLE vfs_nodes (
  inode INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('file','dir','symlink')),
  mode INTEGER NOT NULL DEFAULT 493,
  mtime INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  mount_root TEXT,
  stub_size INTEGER,
  manifest_hash BLOB,
  link_target TEXT,
  size INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX vfs_changes_by_path ON vfs_changes(path, id DESC);
CREATE INDEX vfs_changes_by_rev ON vfs_changes(rev);
CREATE INDEX vfs_chunks_by_hash ON vfs_chunks(hash);
CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode);
CREATE INDEX vfs_nodes_by_manifest_hash
  ON vfs_nodes(manifest_hash) WHERE manifest_hash IS NOT NULL;
CREATE INDEX vfs_nodes_by_rev ON vfs_nodes(rev);

INSERT INTO _vfs_fetch_cursor (k, backend, path)
VALUES ('fetch', 'default', NULL);
INSERT INTO _vfs_watermark (k, backend, v)
VALUES ('pushRev', 'default', 0), ('fetchRev', 'default', 0);

INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (
  X'2E62B215C07B0EBE811E2846ACF170E68223F92505E5F9B2017F1B24E72D47C8',
  18,
  1723500000000
);
INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (
  X'2E62B215C07B0EBE811E2846ACF170E68223F92505E5F9B2017F1B24E72D47C8',
  X'6473682D656467652D302E312E332D766673'
);
INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (
  3,
  0,
  X'2E62B215C07B0EBE811E2846ACF170E68223F92505E5F9B2017F1B24E72D47C8',
  18
);
INSERT INTO vfs_dirents (parent_inode, name, child_inode)
VALUES (1, 'workspace', 2), (2, 'released.txt', 3);
INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (
  X'98E9D74C8E3AF8A05564E01A6DC9B47D9D2147F8FD89B43B1A91C07BBD048048',
  18,
  X'7B2276657273696F6E223A312C226368756E6B73223A5B7B2268617368223A2232653632623231356330376230656265383131653238343661636631373065363832323366393235303565356639623230313766316232346537326434376338222C2273697A65223A31387D5D7D',
  1723500000000
);
INSERT INTO vfs_meta (k, v)
VALUES ('schema_version', 5), ('rev', 3);
INSERT INTO vfs_nodes (
  inode, type, mode, mtime, rev, mount_root, stub_size, manifest_hash,
  link_target, size
) VALUES
  (1, 'dir', 493, 1723500000000, 0, NULL, NULL, NULL, NULL, 0),
  (2, 'dir', 493, 1723500000000, 2, NULL, NULL, NULL, NULL, 0),
  (
    3,
    'file',
    420,
    1723500000000,
    3,
    NULL,
    NULL,
    X'98E9D74C8E3AF8A05564E01A6DC9B47D9D2147F8FD89B43B1A91C07BBD048048',
    NULL,
    18
  );

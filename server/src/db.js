// 저장소: 계정, 방, 글자 메시지만 보관한다. 파일 내용은 절대 저장하지 않는다.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      is_public INTEGER NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id), created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS members (
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id), joined INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id));
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, created INTEGER NOT NULL,
      UNIQUE (room_id, to_id));
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, room_id INTEGER, dm_key TEXT,
      sender_id INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
      reply_to INTEGER, file TEXT, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
      room_id INTEGER, msg_id INTEGER, from_id INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_notice_user ON notices(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, id);
    CREATE INDEX IF NOT EXISTS idx_msg_dm ON messages(dm_key, id);
  `);
  return db;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(password, salt, 32).toString('hex');
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(expected, actual);
}

export const newToken = () => randomBytes(24).toString('hex');
export const dmKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

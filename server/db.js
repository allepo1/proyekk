require('dotenv').config();

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@supabase/supabase-js');

const DB_FILE = path.join(__dirname, 'data', 'app.db');
if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const useSupabase = Boolean(supabaseUrl && supabaseKey);

let sqliteDb = null;
let supabase = null;
let mode = 'sqlite';

if (useSupabase) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  mode = 'supabase';
} else {
  sqliteDb = new sqlite3.Database(DB_FILE);
  sqliteDb.serialize(() => {
    sqliteDb.run('PRAGMA foreign_keys = ON');

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      passwordHash TEXT,
      createdAt TEXT
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      title TEXT,
      text TEXT,
      canvasJson TEXT,
      audioUrl TEXT,
      tags TEXT,
      createdAt TEXT,
      updatedAt TEXT,
      FOREIGN KEY(userId) REFERENCES users(id)
    )`);

    sqliteDb.all(`PRAGMA table_info(notes)`, (err, cols) => {
      if (err) return;
      const hasTitle = Array.isArray(cols) && cols.some((c) => c.name === 'title');
      if (!hasTitle) {
        sqliteDb.run(`ALTER TABLE notes ADD COLUMN title TEXT`);
      }
    });

    sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_notes_userId ON notes(userId)`);
  });
}

function normalizeSupabaseRow(row) {
  if (!row) return row;
  return {
    ...row,
    title: row.title ?? '',
    text: row.text ?? '',
    canvasJson: typeof row.canvasJson === 'string' ? row.canvasJson : JSON.stringify(row.canvasJson ?? {}),
    tags: typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags ?? []),
  };
}

function normalizeColumnName(value) {
  return String(value || '').replace(/[`"']/g, '').trim();
}

function parseInsertQuery(query) {
  const match = query.match(/^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)$/i);
  if (!match) return null;
  return {
    table: match[1],
    columns: match[2].split(',').map((c) => normalizeColumnName(c)),
  };
}

function parseUpdateQuery(query) {
  const match = query.match(/^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+)\s+WHERE\s+(.+)$/i);
  if (!match) return null;
  const assignments = match[2]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeColumnName(item.split('=')[0]));
  return { table: match[1], assignments };
}

function toArray(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

function handleSupabaseRun(query, params, callback) {
  const values = toArray(params);
  const insert = parseInsertQuery(query);
  if (insert) {
    const record = {};
    insert.columns.forEach((column, index) => {
      record[column] = values[index];
    });
    (async () => {
      const { data, error } = await supabase.from(insert.table).insert(record).select('id').single();
      if (error) {
        callback?.call({ lastID: null, changes: 0 }, error);
        return;
      }
      callback?.call({ lastID: data?.id ?? null, changes: 1 }, null);
    })();
    return;
  }

  const update = parseUpdateQuery(query);
  if (update) {
    const record = {};
    update.assignments.forEach((column, index) => {
      record[column] = values[index];
    });
    (async () => {
      let req = supabase.from(update.table).update(record);
      if (query.toLowerCase().includes('where id = ? and userid = ?')) {
        req = req.eq('id', values[values.length - 2]).eq('userId', values[values.length - 1]);
      }
      const { data, error } = await req.select('id');
      if (error) {
        callback?.call({ lastID: null, changes: 0 }, error);
        return;
      }
      callback?.call({ lastID: data?.[0]?.id ?? null, changes: Array.isArray(data) ? data.length : 0 }, null);
    })();
    return;
  }

  if (/^DELETE\s+FROM/i.test(query)) {
    const tableMatch = query.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)/i);
    const table = tableMatch ? tableMatch[1] : null;
    (async () => {
      let req = supabase.from(table).delete();
      req = req.eq('id', values[0]).eq('userId', values[1]);
      const { data, error } = await req.select('id');
      if (error) {
        callback?.call({ lastID: null, changes: 0 }, error);
        return;
      }
      callback?.call({ lastID: null, changes: Array.isArray(data) ? data.length : 0 }, null);
    })();
    return;
  }

  callback?.call({ lastID: null, changes: 0 }, new Error('Query tidak didukung untuk Supabase'));
}

function handleSupabaseGet(query, params, callback) {
  const values = toArray(params);
  const selectMatch = query.match(/^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+([a-zA-Z0-9_]+)\s*=\s*\?$/i);
  if (selectMatch) {
    const table = selectMatch[2];
    const field = normalizeColumnName(selectMatch[3]);
    (async () => {
      const { data, error } = await supabase.from(table).select('*').eq(field, values[0]).maybeSingle();
      if (error) {
        callback?.(error, null);
        return;
      }
      callback?.(null, normalizeSupabaseRow(data));
    })();
    return;
  }

  const noteMatch = query.match(/^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+id\s*=\s*\?\s+AND\s+userId\s*=\s*\?$/i);
  if (noteMatch) {
    const table = noteMatch[2];
    (async () => {
      const { data, error } = await supabase.from(table).select('*').eq('id', values[0]).eq('userId', values[1]).maybeSingle();
      if (error) {
        callback?.(error, null);
        return;
      }
      callback?.(null, normalizeSupabaseRow(data));
    })();
    return;
  }

  callback?.(new Error('Query SELECT tidak didukung untuk Supabase'), null);
}

function handleSupabaseAll(query, params, callback) {
  const values = toArray(params);
  const listMatch = query.match(/^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+userId\s*=\s*\?\s+AND\s*\(title\s+LIKE\s*\?\s+OR\s+text\s+LIKE\s*\?\s+OR\s+tags\s+LIKE\s*\?\)\s+ORDER\s+BY\s+updatedAt\s+DESC$/i);
  if (listMatch) {
    const table = listMatch[2];
    const search = values[1] || '%';
    (async () => {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq('userId', values[0])
        .or(`title.ilike.%${search.replace(/^%|%$/g, '')}%,text.ilike.%${search.replace(/^%|%$/g, '')}%,tags.ilike.%${search.replace(/^%|%$/g, '')}%`)
        .order('updatedAt', { ascending: false });
      if (error) {
        callback?.(error, []);
        return;
      }
      callback?.(null, (data || []).map(normalizeSupabaseRow));
    })();
    return;
  }

  callback?.(new Error('Query SELECT tidak didukung untuk Supabase'), []);
}

const adapter = {
  mode,
  run(query, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (useSupabase) {
      handleSupabaseRun(query, params, callback);
      return;
    }
    sqliteDb.run(query, toArray(params), function (err) {
      callback?.call(this, err);
    });
  },
  get(query, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (useSupabase) {
      handleSupabaseGet(query, params, callback);
      return;
    }
    sqliteDb.get(query, toArray(params), function (err, row) {
      callback?.(err, row);
    });
  },
  all(query, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (useSupabase) {
      handleSupabaseAll(query, params, callback);
      return;
    }
    sqliteDb.all(query, toArray(params), function (err, rows) {
      callback?.(err, rows);
    });
  },
  serialize(fn) {
    if (useSupabase) {
      fn();
      return;
    }
    sqliteDb.serialize(fn);
  },
};

module.exports = adapter;

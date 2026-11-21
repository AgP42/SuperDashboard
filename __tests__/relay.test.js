import {parseRelay, dueBucket, dueLabel, ageLabel} from '../src/relay';

jest.mock('../src/paths', () => ({cacheDir: jest.fn().mockResolvedValue('/cache/')}));

const feed = (over = {}) =>
  JSON.stringify({
    schema: 'relay-tasks',
    schemaVersion: 1,
    generatedAt: '2026-11-21T18:04:00Z',
    generator: 'Relay 1.2.0',
    lists: [{id: 'inbox', name: 'Inbox', order: 0}, {id: 'l-work', name: 'Work', order: 1}],
    tasks: [
      {
        id: '1700000000000039595',
        listId: 'l-work',
        list: 'Work',
        title: "Review Alex's proposal",
        detail: 'Check last year’s figures first.',
        done: false,
        due: '2026-11-24',
        importance: '0',
        reminder: true,
        completedAt: null,
        lastModified: '2026-11-20T09:12:00Z',
        note: {path: '/storage/emulated/0/Note/Work/Meeting notes.note', name: 'Meeting notes', page: 3},
        futureField: 42,
      },
      {id: 'x2', listId: 'inbox', list: 'Inbox', title: 'Urgent', done: true, due: null, importance: '1', completedAt: '2026-11-20T10:00:00Z', note: null},
      {id: 'bad-no-title', listId: 'inbox'},
    ],
    ...over,
  });

describe('parseRelay', () => {
  it('parses the spec example and ignores unknown fields', () => {
    const p = parseRelay(feed());
    expect(p.ok).toBe(true);
    const f = p.feed;
    expect(f.lists).toHaveLength(2);
    expect(f.tasks).toHaveLength(2); // the task without a title is skipped
    const [a, b] = f.tasks;
    expect(a).toMatchObject({id: '1700000000000039595', done: false, due: '2026-11-24', important: false, reminder: true});
    expect(a.note).toEqual({path: '/storage/emulated/0/Note/Work/Meeting notes.note', name: 'Meeting notes', page: 3});
    expect(b).toMatchObject({done: true, important: true, note: null, detail: ''});
  });

  it("parses Relay's own sample file (40 tasks, 5 lists)", () => {
    const text = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/relay-tasks.sample.json'), 'utf8');
    const p = parseRelay(text);
    expect(p.ok).toBe(true);
    expect(p.feed.lists).toHaveLength(5);
    expect(p.feed.tasks).toHaveLength(40);
    expect(p.feed.tasks.filter(t => t.note)).toHaveLength(15);
    expect(p.feed.tasks.filter(t => t.reminder)).toHaveLength(9);
    expect(p.feed.tasks.filter(t => t.done)).toHaveLength(6);
    const ids = new Set(p.feed.lists.map(l => l.id));
    expect(p.feed.tasks.every(t => ids.has(t.listId))).toBe(true);
  });

  it('tolerates a BOM', () => {
    expect(parseRelay('﻿' + feed()).ok).toBe(true);
  });

  it('rejects bad JSON, wrong schema, and newer major versions', () => {
    expect(parseRelay('{"schema":"relay-tasks"')).toEqual({ok: false, reason: 'bad-json'});
    expect(parseRelay(feed({schema: 'other'}))).toEqual({ok: false, reason: 'bad-schema'});
    expect(parseRelay(feed({schemaVersion: 2}))).toEqual({ok: false, reason: 'too-new', version: 2});
  });

  it('drops malformed optional values instead of failing', () => {
    const p = parseRelay(feed({tasks: [{id: 'a', title: 't', due: '24/11/2026', note: {path: '/x/Foo.note', page: 0}}]}));
    expect(p.ok).toBe(true);
    expect(p.feed.tasks[0].due).toBeNull();
    expect(p.feed.tasks[0].note).toEqual({path: '/x/Foo.note', name: 'Foo', page: 1});
  });
});

describe('dates', () => {
  const now = new Date(2026, 10, 21, 12, 0); // Sat 21 Nov 2026, local
  it('buckets due days', () => {
    expect(dueBucket(null, now)).toBe('none');
    expect(dueBucket('2026-11-20', now)).toBe('overdue');
    expect(dueBucket('2026-11-21', now)).toBe('today');
    expect(dueBucket('2026-11-22', now)).toBe('tomorrow');
    expect(dueBucket('2026-11-28', now)).toBe('week');
    expect(dueBucket('2026-12-15', now)).toBe('later');
  });
  it('labels due days', () => {
    expect(dueLabel('2026-11-21', now)).toBe('today');
    expect(dueLabel('2026-11-24', now)).toBe('Tue 24');
    expect(dueLabel('2026-12-15', now)).toBe('15 Dec');
    expect(dueLabel('2027-01-05', now)).toBe('5 Jan 2027');
  });
  it('labels feed age', () => {
    const t = Date.parse('2026-11-21T18:04:00Z');
    expect(ageLabel('2026-11-21T18:04:00Z', t + 30e3)).toBe('just now');
    expect(ageLabel('2026-11-21T18:04:00Z', t + 5 * 60e3)).toBe('5 min ago');
    expect(ageLabel('2026-11-21T18:04:00Z', t + 3 * 3600e3)).toBe('3 h ago');
    expect(ageLabel('2026-11-21T18:04:00Z', t + 3 * 86400e3)).toBe('3 d ago');
    expect(ageLabel(null, t)).toBe('unknown');
  });
});

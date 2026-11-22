import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePage, missingMarks, csvCell, importMissingMark } from './backfill-history.mjs';

const html = `<title>Test看过的影视(31)</title>
<li class="item"><div class="title"><a href="https://movie.douban.com/subject/123/">Film A</a></div>
<span class="date"><span class="rating4-t"></span>2026-10-01</span>
<span class="tags">标签: sci-fi favorite</span><p class="comment">A useful comment (1有用)</p></li>
<span class="subject-num">1-30 / 31</span><div class="paginator"><span class="next"><a href="?start=30">next</a></span></div>`;
const url = 'https://movie.douban.com/people/test/collect?start=0';

test('exports original status, date, rating, comment, tags and next page', () => {
  const result = parsePage(html, 'collect', url);
  assert.equal(result.count, 31);
  assert.equal(result.slots, 30);
  assert.equal(result.start, 1);
  assert.equal(result.end, 30);
  assert.equal(result.next, 'https://movie.douban.com/people/test/collect?start=30');
  assert.deepEqual(result.rows[0], {
    id: '123', title: 'Film A', link: 'https://movie.douban.com/subject/123/',
    status: 'complete', date: '2026-10-01', rating: 8, comment: 'A useful comment', tags: ['sci-fi', 'favorite'],
  });
  assert.equal(parsePage(html, 'wish', url).rows[0].status, 'wishlist');
});

test('rejects login pages, incomplete marks and unexpected pagination hosts', () => {
  assert.throws(() => parsePage('<title>Login</title>', 'collect', url), /collection total/);
  assert.throws(() => parsePage(html.replace('1-30 / 31', ''), 'collect', url), /page range/);
  assert.throws(() => parsePage(html.replace('2026-10-01', ''), 'collect', url), /mark date/);
  assert.throws(() => parsePage(html.replace('?start=30', 'https://example.com/'), 'collect', url), /pagination origin/);
});

test('keeps existing marks regardless of shelf status, including in-progress marks', () => {
  const rows = [{ id: '123', status: 'wishlist' }, { id: '456', status: 'complete' }];
  const marks = [{ shelf_type: 'progress', item: { external_resources: [{ url: 'http://movie.douban.com/subject/123/' }] } }];
  assert.deepEqual(missingMarks(rows, marks), [rows[1]]);
});

test('preserves CSV quotes and prevents spreadsheet formulas in exported text', () => {
  assert.equal(csvCell('A "quote"'), '"A ""quote"""');
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell(8), '"8"');
});


test('only creates a mark after an explicit 404; existing and unauthorized marks are untouched', async () => {
  const row = { id: '123', title: 'A', link: 'https://movie.douban.com/subject/123/', status: 'complete', date: '2026-10-01', rating: 8, comment: 'Original', tags: ['favorite'] };
  const posts = [];
  let statusCode = 200;
  const api = {
    get: path => path === 'catalog/fetch'
      ? { json: async () => ({ uuid: 'a', category: 'tv' }) }
      : Promise.resolve({ statusCode }),
    post: async (path, body) => posts.push({ path, ...body }),
  };
  assert.equal(await importMissingMark(api, row), null);
  assert.equal(posts.length, 0);
  statusCode = 401;
  await assert.rejects(importMissingMark(api, row), /HTTP 401/);
  assert.equal(posts.length, 0);
  statusCode = 404;
  assert.equal((await importMissingMark(api, row)).category, 'tv');
  assert.deepEqual(posts, [{ path: 'me/shelf/item/a', json: {
    shelf_type: 'complete', visibility: 2, comment_text: 'Original', rating_grade: 8,
    tags: ['favorite'], created_time: '2026-10-01T00:00:00+08:00', post_to_fediverse: false,
  } }]);
});

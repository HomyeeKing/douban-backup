import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import got from 'got';
import { JSDOM } from 'jsdom';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parsePage(html, shelf, pageUrl) {
  const doc = new JSDOM(html, { url: pageUrl }).window.document;
  const count = Number(doc.title.match(/[（(](\d+)[）)]/)?.[1]);
  assert(Number.isInteger(count), 'Missing movie collection total');
  const rows = [...doc.querySelectorAll('li.item')].map(el => {
    const link = el.querySelector('.title a');
    const id = link?.href.match(/movie\.douban\.com\/subject\/(\d+)/)?.[1];
    const date = el.querySelector('.date')?.textContent.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    assert(id && date, 'Incomplete movie mark: missing link or mark date');
    const rating = el.querySelector('[class*="rating"][class*="-t"]')?.className.match(/rating([1-5])-t/)?.[1];
    return {
      id, title: link.textContent.trim(), link: `https://movie.douban.com/subject/${id}/`,
      status: shelf === 'collect' ? 'complete' : 'wishlist', date,
      rating: rating ? Number(rating) * 2 : 0,
      comment: (el.querySelector('.comment')?.textContent || '').trim().replace(/\s*[（(]\d+\s*有用[）)]\s*$/, ''),
      tags: (el.querySelector('.tags')?.textContent || '').replace(/^\s*标签[:：]\s*/, '').trim().split(/\s+/).filter(Boolean),
    };
  });
  const next = doc.querySelector('.paginator span.next a')?.getAttribute('href');
  const nextUrl = next ? new URL(next, pageUrl) : null;
  if (nextUrl) assert(nextUrl.origin === 'https://movie.douban.com', 'Unexpected pagination origin');
  return { count, rows, next: nextUrl?.href };
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function missingMarks(rows, marks) {
  const ids = new Set(marks.flatMap(mark => (mark.item?.external_resources || []).map(resource =>
    resource.url?.match(/movie\.douban\.com\/subject\/(\d+)/)?.[1]).filter(Boolean)));
  return rows.filter(row => !ids.has(row.id));
}

async function exportShelf(user, shelf) {
  let url = `https://movie.douban.com/people/${encodeURIComponent(user)}/${shelf}?start=0&sort=time&rating=all&filter=all&mode=list`;
  const visited = new Set();
  const rows = [];
  let expected;
  while (url) {
    assert(!visited.has(url), 'Repeated movie collection page');
    visited.add(url);
    const html = await got(url, { timeout: { request: 30000 } }).text();
    let page;
    try { page = parsePage(html, shelf, url); }
    catch (error) {
      fs.writeFileSync(`history-export/${shelf}-parse-error.html`, html);
      throw error;
    }
    if (page.rows.length < 30 && page.next) fs.writeFileSync(`history-export/${shelf}-short-page.html`, html);
    expected ??= page.count;
    assert(page.count === expected, 'Movie collection changed during export');
    rows.push(...page.rows);
    console.log(`${shelf}: exported ${rows.length}/${expected}`);
    url = page.next;
    if (url) await sleep(1500);
  }
  fs.writeFileSync(`history-export/${shelf}-export.json`, JSON.stringify(rows, null, 2));
  assert(rows.length === expected && new Set(rows.map(row => row.id)).size === expected, 'Incomplete movie export');
  return rows;
}

async function fetchMarks(api) {
  const marks = [];
  for (const shelf of ['complete', 'wishlist', 'progress']) {
    const shelfMarks = [];
    for (let page = 1; ; page++) {
      const data = await api.get(`me/shelf/${shelf}`, { searchParams: { page } }).json();
      assert(Array.isArray(data.data) && Number.isInteger(data.pages) && Number.isInteger(data.count), 'Invalid NeoDB pagination');
      shelfMarks.push(...data.data);
      if (page >= data.pages) {
        assert(shelfMarks.length === data.count, 'Incomplete NeoDB shelf count');
        marks.push(...shelfMarks);
        break;
      }
      assert(data.data.length > 0, 'Incomplete NeoDB shelf');
    }
  }
  return marks;
}

async function main() {
  assert(process.env.DOUBAN_USER_ID && process.env.NEODB_API_TOKEN, 'Douban and NeoDB account configuration is required');
  const apply = process.env.BACKFILL_APPLY === 'true';
  fs.mkdirSync('history-export', { recursive: true });
  const rows = [...await exportShelf(process.env.DOUBAN_USER_ID, 'collect'), ...await exportShelf(process.env.DOUBAN_USER_ID, 'wish')];
  assert(new Set(rows.map(row => row.id)).size === rows.length, 'Conflicting marks across Douban shelves');
  fs.writeFileSync('history-export/douban-movies.json', JSON.stringify(rows, null, 2));
  const header = ['标题', '豆瓣链接', '状态', '标记日期', '评分（10分）', '短评', '标签'];
  const csv = [header, ...rows.map(row => [row.title, row.link, row.status, row.date, row.rating || '', row.comment, row.tags.join(' ')])];
  fs.writeFileSync('history-export/douban-movies.csv', '\uFEFF' + csv.map(row => row.map(csvCell).join(',')).join('\r\n'));
  const api = got.extend({ prefixUrl: 'https://neodb.social/api/', headers: { Authorization: `Bearer ${process.env.NEODB_API_TOKEN}`, Accept: 'application/json' }, timeout: { request: 30000 } });
  const existing = await fetchMarks(api);
  const missing = missingMarks(rows, existing);
  fs.writeFileSync('history-export/missing-marks.json', JSON.stringify(missing, null, 2));
  console.log(`Exported ${rows.length}; missing from NeoDB by Douban link: ${missing.length}; apply: ${apply}`);
  const report = { exported: rows.length, candidates: missing.length, inserted: [], skipped: [], failed: [] };
  if (apply) {
    for (const row of missing) {
      try {
        let item;
        for (let attempt = 0; attempt < 5; attempt++) {
          item = await api.get('catalog/fetch', { searchParams: { url: row.link } }).json();
          if (item.uuid) break;
          await sleep(1500);
        }
        assert(item.uuid && ['movie', 'tv'].includes(item.category), 'Movie/TV catalog lookup did not finish');
        const response = await api.get(`me/shelf/item/${item.uuid}`, { throwHttpErrors: false });
        if (response.statusCode === 200) {
          report.skipped.push(row);
          continue;
        }
        assert(response.statusCode === 404, `Cannot check existing mark: HTTP ${response.statusCode}`);
        await api.post(`me/shelf/item/${item.uuid}`, { json: {
          shelf_type: row.status, visibility: 2, comment_text: row.comment, rating_grade: row.rating,
          tags: row.tags, created_time: `${row.date}T00:00:00+08:00`, post_to_fediverse: false,
        } });
        report.inserted.push({ ...row, category: item.category, uuid: item.uuid });
        console.log(`Inserted ${row.status}: ${row.title}`);
      } catch (error) {
        report.failed.push({ ...row, error: error.message });
        console.error(`Failed ${row.title}: ${error.message}`);
      }
      await sleep(500);
    }
  }
  fs.writeFileSync('history-export/report.json', JSON.stringify(report, null, 2));
  console.log(`Inserted ${report.inserted.length}; skipped ${report.skipped.length}; failed ${report.failed.length}`);
  assert(report.failed.length === 0, 'Some historical marks could not be imported; see report.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

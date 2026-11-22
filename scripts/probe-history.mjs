import assert from 'node:assert/strict';
import got from 'got';
import { JSDOM } from 'jsdom';

assert(process.env.DOUBAN_USER_ID, 'Douban account is configured');
let accessible = true;
for (const shelf of ['collect', 'wish']) {
  const url = new URL(`https://movie.douban.com/people/${encodeURIComponent(process.env.DOUBAN_USER_ID)}/${shelf}`);
  url.search = 'start=0&sort=time&rating=all&filter=all&mode=list';
  try {
    const response = await got(url, { throwHttpErrors: false, retry: { limit: 0 }, timeout: { request: 15000 } });
    const doc = new JSDOM(response.body).window.document;
    const items = doc.querySelectorAll('li.item .title a');
    console.log(JSON.stringify({ shelf, status: response.statusCode, pageTitle: doc.title, itemsOnFirstPage: items.length }));
    if (response.statusCode !== 200 || items.length === 0) accessible = false;
  } catch (error) {
    console.log(JSON.stringify({ shelf, error: error.code }));
    accessible = false;
  }
}
assert(accessible, 'Full movie lists are not accessible from this CI session; a logged-in export is needed');

// Opens a URL, waits, prints the overlay and saves a screenshot. Usage: node scripts/shot.mjs "<query>" <seconds> <png>
import { launch, BASE } from './browser.mjs';
const [query = '', secs = '6', png = 'shot.png'] = process.argv.slice(2);
const browser = await launch(process.env.BROWSER ?? 'chrome');
const page = (await browser.pages())[0];
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
await page.goto(BASE + query);
await new Promise((r) => setTimeout(r, Number(secs) * 1000));
console.log(await page.evaluate(() => document.getElementById('overlay').textContent));
console.log(errors.slice(0, 8).join('\n'));
await page.screenshot({ path: png });
await browser.close();

// Run with ADMIN_STATE and USER_STATE pointing to Playwright storage-state files.
// Session files are read by Playwright only; their contents are never printed.
import { chromium } from '../../tests/browser/node_modules/playwright-core/index.mjs';
const base = process.env.ADMIN_PROBE_URL || 'http://localhost:3000';
const edge = process.env.ADMIN_PROBE_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const paths = ['/admin','/admin/users','/admin/content','/admin/files','/admin/comments','/admin/teams','/admin/bookings','/admin/payments','/admin/places','/admin/system','/admin/audit'];
const browser = await chromium.launch({executablePath:edge,headless:true});
try {
  if (process.env.USER_STATE) {
    const context = await browser.newContext({storageState:process.env.USER_STATE}); const page = await context.newPage();
    const response = await page.goto(`${base}/admin`,{waitUntil:'domcontentloaded'}); console.log(`non-admin guard: HTTP ${response?.status()}`); await context.close();
  } else console.log('non-admin guard: skipped (USER_STATE not supplied)');
  if (!process.env.ADMIN_STATE) { console.log('admin pages: skipped (ADMIN_STATE not supplied)'); process.exitCode=2; }
  else for (const theme of ['light','dark']) for (const width of [390,1280]) {
    const context=await browser.newContext({storageState:process.env.ADMIN_STATE,viewport:{width,height:844},colorScheme:theme}); const page=await context.newPage();
    for (const path of paths) {
      const failures=[]; const listener=response=>{if(response.url().includes('/api/v1/admin') && response.status() >= 400) failures.push(response.status());}; page.on('response',listener);
      const response=await page.goto(`${base}${path}`,{waitUntil:'networkidle'}); const heading=await page.locator('h1').first().textContent().catch(()=>null);
      console.log(`live ${theme} ${width} ${path}: page ${response?.status()}, heading ${heading ? 'present' : 'missing'}, API errors ${failures.join(',') || 'none observed'}`); page.off('response',listener);
    }
    // Simulations verify rendering only; they are not evidence of backend coverage.
    for (const path of paths) for (const mode of ['loading','empty','error']) {
      await page.route('**/api/v1/admin/**', async route=>{ if(mode==='loading') { await new Promise(resolve=>setTimeout(resolve,1500)); } const summary=path==='/admin'||path==='/admin/system'; return route.fulfill(mode==='error'?{status:503,json:{error:{code:'UNAVAILABLE',message:'Probe error'}}}:{status:200,json:summary?{data:{}}:{data:[],meta:{nextCursor:null}}}); });
      await page.goto(`${base}${path}`,{waitUntil:'domcontentloaded'}); const summary=path==='/admin'||path==='/admin/system'; const expected=mode==='loading'?'Loading':mode==='error'?'Probe error':summary?null:'No results found';
      const visible=expected ? await page.getByText(expected,{exact:false}).first().isVisible().catch(()=>false) : await page.locator('h1').isVisible().catch(()=>false);
      console.log(`simulated ${theme} ${width} ${path} ${mode}: ${visible?'visible':'missing'}`); await page.unrouteAll({behavior:'ignoreErrors'});
    }
    await context.close();
  }
} finally { await browser.close(); }

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('apps/web/dist');
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const path = resolve(root, '.' + (pathname.startsWith('/assets/') ? pathname : '/index.html'));
  try {
    res.setHeader('content-type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  let saved;
  let oauthConfig;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === '/api/mail/accounts') {
      if (route.request().method() === 'POST') saved = route.request().postDataJSON();
      data = { accounts: [] };
    } else if (path === '/api/mail/gmail/settings') {
      if (route.request().method() === 'PUT') oauthConfig = route.request().postDataJSON();
      data = { clientId: '', hasClientSecret: false, redirectUri: 'http://127.0.0.1:4317/api/mail/gmail/callback' };
    } else if (path === '/api/mail/gmail/connect') data = { url: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1' };
    else if (path === '/api/sources') data = { sources: [] };
    else if (path === '/api/tasks') data = { tasks: [] };
    return route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/mail`);
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByLabel('邮箱服务').selectOption('gmail');
  await page.getByLabel('发件地址').fill('test@gmail.com');
  await page.getByLabel('Google 应用专用密码', { exact: true }).fill('abcd efgh ijkl mnop');
  assert.equal(await page.getByLabel('定时同步收件箱（只读）').isChecked(), false);
  await page.getByRole('button', { name: '添加账户', exact: true }).click();
  await page.getByText('账户已创建，可以测试或同步。', { exact: true }).waitFor();
  assert.equal(saved.smtp.host, 'smtp.gmail.com');
  assert.equal(saved.smtp.user, 'test@gmail.com');
  assert.equal(saved.smtp.password, 'abcdefghijklmnop');
  assert.equal(saved.imap.password, saved.smtp.password);
  assert.equal(saved.syncEnabled, false);
  assert.deepEqual(errors, []);
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Mock Google authorization</p>' }));
  await page.getByLabel('Google Client ID').fill('ui-test.apps.googleusercontent.com');
  await page.getByLabel('Google Client Secret').fill('mock-client-secret');
  await page.getByRole('button', { name: '连接 Google 账户', exact: true }).click();
  await page.waitForURL('https://accounts.google.com/**');
  assert.equal(oauthConfig.clientId, 'ui-test.apps.googleusercontent.com');
  assert.equal(oauthConfig.clientSecret, 'mock-client-secret');
  await page.goto(`http://127.0.0.1:${server.address().port}/mail?gmail=connected`);
  await page.getByRole('heading', { name: '连接 Gmail', exact: true }).waitFor();
  const now = new Date().toISOString();
  const settings = { executorEnabled: {}, approvalMode: 'necessary', preferredExecutorId: null };
  const conversation = { id: 'mail-chat', title: '请假信', settings, createdAt: now, updatedAt: now };
  let prepared;
  let approvals = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === '/api/conversations') data = { conversations: [conversation] };
    else if (path === '/api/conversations/mail-chat') data = { conversation, proposals: [], messages: [
      { id: 'u', role: 'user', content: '邮件格式', attachments: [], createdAt: now },
      { id: 'a', role: 'assistant', content: '主题：12月初回国\n\n妈：\n我12月初就回国了。\n\n需要我直接帮你补成日期和署名吗？', attachments: [], createdAt: now }
    ] };
    else if (path === '/api/health') data = { chatModel: { configured: true, settings: { providerName: 'Test', model: 'mock' } } };
    else if (path === '/api/mail/accounts') data = { accounts: [{ id: 'gmail', fromAddress: 'test@gmail.com' }] };
    else if (path === '/api/tasks') data = { tasks: [] };
    else if (path === '/api/outbox') { prepared = route.request().postDataJSON(); data = { id: 'chat-draft' }; }
    else if (path.endsWith('/chat-draft/submit')) { approvals++; data = { task: { id: 'mail-send' } }; }
    else if (path === '/api/tasks/mail-send') data = { task: { id: 'mail-send', status: 'waiting_approval' }, approvals: [], effects: [] };
    return route.fulfill({ json: data });
  });
  await page.evaluate(() => localStorage.setItem('hearth.conversation', 'mail-chat'));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByLabel('信件正文').waitFor();
  assert.equal(await page.getByLabel('邮件主题').inputValue(), '12月初回国');
  assert.equal(await page.getByLabel('信件正文').inputValue(), '妈：\n我12月初就回国了。');
  await page.getByLabel('信件正文').fill('老师您好，我叫小兰，今天感冒，明天来上课。', { timeout: 10000 }).catch(async error => { console.error(errors, await page.locator('body').innerText()); throw error; });
  await page.getByLabel('收件人邮箱').fill('teacher@example.com');
  await page.getByLabel('邮件主题').fill('小兰请假申请');
  await page.getByRole('button', { name: '准备发送邮件' }).click();
  await page.getByRole('link', { name: '查看发送状态', exact: true }).waitFor();
  assert.equal(prepared.subject, '小兰请假申请');
  assert.equal(prepared.body, '老师您好，我叫小兰，今天感冒，明天来上课。');
  assert.deepEqual(prepared.to, ['teacher@example.com']);
  assert.equal(approvals, 1);
  assert.equal(await page.getByRole('button', { name: '准备发送邮件' }).isDisabled(), true);
  const routeModes = [];
  await page.route('**/api/chat', async route => {
    routeModes.push(route.request().postDataJSON().routeMode);
    const reply = { id: `reply-${routeModes.length}`, role: 'assistant', content: '已按要求补充。', attachments: [], createdAt: now };
    await route.fulfill({ contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(reply)}\n\nevent: end\ndata: {}\n\n` });
  });
  for (const mode of ['chat', 'task']) {
    await page.getByLabel('消息处理方式').selectOption(mode);
    await page.locator('.composer textarea').fill('再加一句 这是由Hearth agent发送的邮件！');
    await page.locator('.composer-send').click();
    await page.getByLabel('消息处理方式').waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="消息处理方式"]').disabled);
  }
  assert.deepEqual(routeModes, ['chat', 'task']);
  assert.deepEqual(errors, []);
  console.log('Gmail setup and editable chat mail UI passed (mock API; no mail sent).');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

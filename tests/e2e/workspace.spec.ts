import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
test.beforeEach(async () => {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://copilot:copilot_local@localhost:54329/credit_copilot_test';
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('DELETE FROM cases.login_attempts');
  } finally {
    await db.end();
  }
});
const shot = (name: string) => join(tmpdir(), `credit-copilot-${name}.png`);
async function login(page: Page, username: string) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(`e2e-${username}`);
  await page.getByLabel('Password', { exact: true }).fill('e2e-only-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
}
async function add(page: Page, reference = 'APP-001') {
  await page.getByRole('button', { name: 'Add application', exact: true }).click();
  await page.getByLabel('Reviewed pack').selectOption(reference);
  const added = page.waitForResponse(
    (r) => r.url().includes('/applications/fixtures/') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Add selected pack' }).click();
  expect((await added).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: reference, exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Assessment mode')).toBeVisible();
}
test('login errors, restored cookie session, logout and mobile layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Username').fill('invalid');
  await page.getByLabel('Password').fill('incorrect');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await login(page, 'basic');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Add application', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: shot('mobile'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('assessment progress reconnects with a cursor and reaches the saved result', async ({
  page,
}) => {
  await login(page, 'stream');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await add(page);
  await expect(page).toHaveTitle(/Credit Copilot/);
  let starts = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/assessment-streams')) starts++;
  });
  let requests = 0;
  let resumeCursor: string | undefined;
  let release!: () => void;
  const reconnect = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/assessment-streams/*', async (route) => {
    requests++;
    if (requests === 1) {
      const response = await route.fetch();
      const firstFrame = (await response.text()).split('\n\n')[0];
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `${firstFrame}\n\n`,
      });
      return;
    }
    resumeCursor = route.request().headers()['last-event-id'];
    await reconnect;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Run assessment', exact: true }).click();
  try {
    await expect(page.getByRole('progressbar', { name: 'Assessment progress' })).toHaveAttribute(
      'value',
      '1',
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'Reconnecting to assessment' }),
    ).toBeVisible();
    await page.screenshot({ path: shot('stream-desktop'), fullPage: true });
  } finally {
    release();
  }
  await expect(page.getByText('Missing evidence: national id copy')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Assessment saved for human review.' }),
  ).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  expect(resumeCursor).toBe('1');
  expect(requests).toBe(2);
  expect(starts).toBe(1);
  expect(errors).toEqual([]);
});

test('Strict default, evidence download, sources, workflow and fraud referral', async ({
  page,
}) => {
  await login(page, 'strict');
  await add(page);
  await expect(page.getByLabel('Assessment mode')).toHaveValue('strict');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download original' }).click();
  expect((await download).suggestedFilename()).toBe('APP-001.pdf');
  await page.getByRole('button', { name: 'Run assessment', exact: true }).click();
  await expect(page.getByText('Missing evidence: national id copy')).toBeVisible();
  await page.getByRole('tab', { name: 'Rules & sources', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'CP-8' })).toBeVisible();
  await page.screenshot({ path: shot('desktop'), fullPage: true });
  await page.getByRole('tab', { name: 'Workflow', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recorded workflow' })).toBeVisible();
  await add(page, 'APP-004');
  await page.getByRole('button', { name: 'Run assessment', exact: true }).click();
  await expect(page.getByText('Suspected tampering.', { exact: false })).toBeVisible();
});
test('explicit Demo, four-eyes human review and issued offer keep verification false', async ({
  page,
}, testInfo) => {
  await login(page, 'demo');
  await add(page);
  await page.getByLabel('Assessment mode').selectOption('demo');
  await page.getByRole('button', { name: 'Run assessment', exact: true }).click();
  await expect(
    page.getByText('Demo assessment — not fully evidence-verified.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('EGP 8,630.39', { exact: true })).toBeVisible();
  const response = await page.request.get('/api/v1/applications');
  const rows = await response.json();
  const id = rows[0].latest_assessment_id as string;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'head');
  await page.getByRole('button', { name: 'Review queue', exact: true }).click();
  await page.getByRole('button', { name: `Review ${id}`, exact: true }).click();
  await page
    .getByLabel('Written justification')
    .fill('Reviewed synthetic evidence and explicit demo assumptions.');
  await page.getByLabel('I reviewed the evidence', { exact: false }).check();
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Action', exact: true })).toHaveValue('issue');
  await page.getByLabel('Disbursement date').fill('2025-04-03');
  await page
    .getByLabel('Written justification')
    .fill('Issue a demo offer after independent approval.');
  await page.getByLabel('I reviewed the evidence', { exact: false }).check();
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await page.getByRole('button', { name: 'View issued offer' }).click();
  await expect(
    page.getByText('Demo offer — not fully evidence-verified.', { exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page
    .getByRole('link', { name: 'Download offer letter and repayment schedule (PDF)' })
    .click();
  const letter = await download;
  expect(letter.suggestedFilename()).toBe('credit-copilot-offer-APP-001.pdf');
  await letter.saveAs(testInfo.outputPath('issued-offer-APP-001.pdf'));
});

test('auto application shows documented funding and cites its own product rules', async ({
  page,
}) => {
  await login(page, 'auto');
  await expect(page).toHaveTitle(/Credit Copilot/);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await add(page, 'AUTO-001');
  await expect(page.getByText('Auto loan (AL-200)', { exact: true })).toBeVisible();
  await expect(page.getByText('EGP 350,000.00', { exact: true })).toBeVisible();
  await page.getByLabel('Assessment mode').selectOption('demo');
  await page.getByRole('button', { name: 'Run assessment', exact: true }).click();
  await expect(page.getByText('EGP 6,623.47', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Rules & sources' }).click();
  await expect(page.getByText('synthetic-auto-product.md PS-9', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Policy questions', exact: true }).click();
  await page.getByRole('combobox', { name: 'Product', exact: true }).selectOption('AL-200');
  await page.getByRole('combobox', { name: 'Policy edition' }).selectOption('AUTO-2025');
  await page
    .getByLabel('Question', { exact: true })
    .fill('What is the minimum down payment for the vehicle loan?');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.getByText('synthetic-auto-product.md', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: shot('auto-policy-mobile'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Usage shows only recorded model activity with unknown provider charges on mobile', async ({
  page,
}) => {
  await login(page, 'usage');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.getByText('No model usage recorded yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Policy questions', exact: true }).click();
  await page.getByLabel('Question', { exact: true }).fill('Maximum DBR in CP-2025?');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Verified source excerpts', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Recorded usage' });
  await expect(summary.getByText('2 calls · 0 failed · 0 retries · 0 fallbacks')).toBeVisible();
  await expect(summary.getByText('Actual provider charges')).toBeVisible();
  await expect(summary.getByText(/^Unknown/, { exact: false }).last()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By model and operation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: shot('usage-live-mobile'), fullPage: true });
  expect(errors).toEqual([]);
});
test('grounded questions, refusal, conflicts and edition-specific code calculations', async ({
  page,
}) => {
  await login(page, 'question');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Policy questions', exact: true }).click();
  await page.getByLabel('Question', { exact: true }).fill('Maximum DBR in CP-2024?');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verified source excerpts' })).toBeVisible();
  await expect(page.locator('.source strong').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: shot('stream-mobile'), fullPage: true });
  await page.getByLabel('As-of date (optional)').fill('2025-04-03');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ConflictingEdition');
  await page.getByLabel('Question', { exact: true }).fill('crypto policy?');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Insufficient evidence' })).toBeVisible();
  await page.getByLabel('Requested amount (EGP)', { exact: true }).fill('300000');
  await page.getByLabel('Net monthly income (EGP)').fill('30000');
  await page.getByLabel('Monthly obligations (EGP)').fill('4000');
  await page.getByLabel('Tenor (months)').fill('60');
  await page.getByLabel('Calculation date').fill('2025-04-03');
  await page.getByRole('button', { name: 'Calculate affordability' }).click();
  await expect(page.getByText('EGP 330,000.00', { exact: true })).toBeVisible();
  await page.getByLabel('Calculation date').fill('2024-12-01');
  await page.getByRole('button', { name: 'Calculate affordability' }).click();
  await expect(page.getByText('EGP 382,000.00', { exact: true })).toBeVisible();
  await page.route('**/api/v1/question-streams/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'id: 1\ndata: {"kind":"failed","code":"QuestionUnavailable"}\n\n',
    }),
  );
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Policy question service is unavailable');
  await expect(page.getByRole('button', { name: 'Ask question', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
test('real multipart upload, duplicate registration and mixed knowledge batch results', async ({
  page,
}) => {
  await login(page, 'upload');
  await page.getByRole('button', { name: 'Add application', exact: true }).click();
  await page
    .getByLabel('Original pack (optional)')
    .setInputFiles('data/corpus/evidence/APP-001.pdf');
  await page.getByRole('button', { name: 'Add selected pack' }).click();
  await expect(page.getByLabel('Assessment mode')).toBeVisible();
  await add(page);
  await expect(page.getByRole('row').filter({ hasText: 'Synthetic pack' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(
    page.getByText('Ingestion requires separate permission.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ingest documents' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'head');
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page
    .getByLabel('Policy files')
    .setInputFiles([
      'data/corpus/policy/credit-policy-2025.pdf',
      'data/corpus/evidence/APP-001.pdf',
    ]);
  await page.getByRole('button', { name: 'Ingest documents' }).click();
  await expect(page.getByText('credit-policy-2025.pdf — skipped', { exact: true })).toBeVisible();
  await expect(
    page.getByText('APP-001.pdf — failed: UntrustedPolicyDocument', { exact: true }),
  ).toBeVisible();
});
test('expired session clears protected UI and a network outage can be retried', async ({
  page,
}) => {
  await login(page, 'basic');
  await page.route('**/api/v1/applications', (route) => route.abort());
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not reach the server');
  await page.unroute('**/api/v1/applications');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('No applications yet.', { exact: false })).toBeVisible();
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('Your session ended.', { exact: false })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
});
test('PM-9 request returns the original written human rejection without changing lifecycle', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'reasons');
  await expect(page).toHaveTitle('Credit Copilot');
  await page.getByRole('button', { name: 'Open TEST-DECLINE', exact: true }).click();
  await page
    .getByLabel('Request message (optional)')
    .fill('Please provide the decision reason in writing.');
  await page.getByRole('button', { name: 'Request written reason', exact: true }).click();
  const reply = page.getByRole('article', { name: 'Written reply' });
  await expect(reply).toContainText('CP-3.5 · CP-2025');
  await expect(reply).toContainText('credit-policy-2025.pdf');
  await expect(reply).toContainText('Demo decision — not fully evidence-verified.');
  await expect(
    page.getByRole('button', { name: 'Request written reason', exact: true }),
  ).toHaveCount(0);
  await reply.screenshot({ path: shot('reply-detail') });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: shot('written-reason'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reply).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: shot('written-reason-mobile'), fullPage: true });
  expect(errors).toEqual([]);
});
test('Senior records an internal referral review without approving or rejecting missing evidence', async ({
  page,
}) => {
  await login(page, 'reasons');
  await add(page, 'APP-001');
  await page.getByRole('button', { name: 'Run assessment', exact: true }).click();
  await expect(page.getByText('Missing evidence: national id copy')).toBeVisible();
  const records = (await (await page.request.get('/api/v1/applications')).json()) as {
    reference: string;
    latest_assessment_id: string;
  }[];
  const id = records.find((r) => r.reference === 'APP-001')!.latest_assessment_id;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'head');
  await page.getByRole('button', { name: 'Review queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Senior referral queue' })).toBeVisible();
  await page.getByRole('button', { name: `Review referral ${id}`, exact: true }).click();
  await page
    .getByLabel('Referral justification')
    .fill('Await the actual required ID evidence before reassessment.');
  await page.getByRole('button', { name: 'Record referral review', exact: true }).click();
  await expect(
    page.getByText('Await the actual required ID evidence before reassessment.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record decision', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: shot('referral-review'), fullPage: true });
});

import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
}) => {
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
});
test('grounded questions, refusal, conflicts and edition-specific code calculations', async ({
  page,
}) => {
  await login(page, 'question');
  await page.getByRole('button', { name: 'Policy questions', exact: true }).click();
  await page.getByLabel('Question', { exact: true }).fill('Maximum DBR in CP-2024?');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verified source excerpts' })).toBeVisible();
  await expect(page.locator('.source strong').first()).toBeVisible();
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

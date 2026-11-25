import { expect, test } from '@playwright/test';

test('full Outreach Engine end-to-end workflow: auth, Outlook, leads, campaigns, sending engine, analytics, exports & WhatsApp QR', async ({
  page,
}) => {
  // 1. Unauthenticated access redirects to login; log in with administrator account
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Admin Email').fill('admin@outreach.local');
  await page.getByLabel('Password').fill('E2eStrongPassword123!');
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page).toHaveURL('http://127.0.0.1:4199/');
  await expect(page.getByText('Email Activity (Last 14 Days)')).toBeVisible();

  // Verify no OAuth/session tokens stored in browser localStorage/sessionStorage
  const storageKeys = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
  }));
  expect(storageKeys.local).toHaveLength(0);
  expect(storageKeys.session).toHaveLength(0);

  // 2. Connect simulated Outlook account & configure account settings (limit=1, delay 15-20m)
  await page.request.post('http://127.0.0.1:4199/__e2e/connect-mock-outlook');
  await page.goto('/accounts');
  await expect(page.getByText('waiz@outlook.com')).toBeVisible();

  await page.getByRole('button', { name: 'Edit Settings' }).click();
  const numberInputs = page.locator('input[type="number"]');
  await numberInputs.nth(0).fill('1'); // Daily limit = 1
  await numberInputs.nth(1).fill('15'); // Min delay = 15
  await numberInputs.nth(2).fill('20'); // Max delay = 20
  const timeInputs = page.locator('input[type="time"]');
  await timeInputs.nth(0).fill('00:00');
  await timeInputs.nth(1).fill('23:59');
  // Ensure all weekdays active
  for (const day of ['Sun', 'Sat']) {
    await page.getByRole('button', { name: day }).click();
  }
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.getByText('Account settings updated successfully.')).toBeVisible();

  // 3. Configure Test Mode verified recipient in Settings
  await page.goto('/settings');
  await page.getByPlaceholder('Verified test recipient email (e.g. you@outlook.com)').fill('verified-owner@outlook.com');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.getByText('System settings saved.')).toBeVisible();

  // 4. Leads page: download lead template + upload CSV with valid, invalid & duplicate rows
  await page.goto('/leads');
  const [templateDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download Lead Upload Template' }).click(),
  ]);
  expect(templateDownload.suggestedFilename()).toBe('outreach-lead-template.csv');

  const csvUpload = [
    'email,first_name,company,subject,body',
    'alice@prospect.com,Alice,Acme,"Proposal for {{company}}","Hi {{first_name}}, let us connect!"',
    'bob@prospect.com,Bob,Beta,"Proposal for {{company}}","Hi {{first_name}}, quick note!"',
    'alice@prospect.com,Alice,Acme,"Dup","Dup body"',
    'not-an-email,Bad,Corp,"Sub","Body"',
  ].join('\n');

  await page.locator('select').first().selectOption({ index: 1 });
  await page.getByLabel('Upload lead file').setInputFiles({
    name: 'leads-test.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvUpload, 'utf8'),
  });
  await page.getByRole('button', { name: 'Upload & Preview Leads' }).click();

  await expect(page.getByText('Valid: 2')).toBeVisible();
  await expect(page.getByText('Invalid: 1')).toBeVisible();
  await expect(page.getByText('Duplicates: 1')).toBeVisible();

  const [invalidDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download Invalid Rows Report' }).click(),
  ]);
  expect(invalidDownload.suggestedFilename()).toContain('invalid-rows-');

  await page.getByRole('button', { name: 'Confirm & Save Valid Leads' }).click();
  await expect(page.getByText(/Import complete: 2 leads added/)).toBeVisible();

  // 5. Create campaign in Test Mode, preview personalized email, start with confirmation
  await page.goto('/campaigns');
  await page.getByRole('button', { name: 'Create Campaign' }).first().click();
  await page.getByPlaceholder('e.g., Q1 Agency Outreach').fill('E2E Test Campaign');
  await page.getByRole('dialog').locator('select').first().selectOption({ index: 1 });
  await page.getByText('Run this campaign in Test Mode').click();
  await page.getByRole('button', { name: 'Select All' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create Campaign' }).click();
  await expect(page.getByText('E2E Test Campaign')).toBeVisible();

  // Preview campaign
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Proposal for Acme')).toBeVisible();
  await page.getByLabel('Close modal').click();

  // Start campaign (with first-email confirmation)
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Confirm & Start Campaign' }).click();
  await expect(page.getByText('ACTIVE', { exact: true }).first()).toBeVisible();

  // Trigger sending engine tick -> sends 1 email (test mode routes to verified-owner@outlook.com), hits daily limit=1
  await page.request.post('http://127.0.0.1:4199/__e2e/tick-engine', { data: { offsetMinutes: 0 } });
  // Second tick immediately -> blocked by delay & daily limit=1
  const tick2 = await page.request.post('http://127.0.0.1:4199/__e2e/tick-engine', {
    data: { offsetMinutes: 25 },
  });
  expect((await tick2.json()).dispatched).toBe(0);

  // Pause campaign and verify it stays paused
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('PAUSED', { exact: true }).first()).toBeVisible();

  // 6. Verify Email Activity, Analytics & Export
  await page.goto('/activity');
  await expect(page.getByText('verified-owner@outlook.com')).toBeVisible();
  await expect(page.getByRole('table').getByText('DELIVERY_UNKNOWN', { exact: true }).first()).toBeVisible();

  const [activityExport] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Activity CSV' }).click(),
  ]);
  expect(activityExport.suggestedFilename()).toBe('email-activity-export.csv');

  await page.goto('/analytics');
  await expect(page.getByText('Provider-Confirmed Metrics')).toBeVisible();

  // 7. WhatsApp QR Connection, Recipient Config, Test Notification, Incoming Reply Alert & Disconnect Queue
  await page.goto('/whatsapp');
  await page.getByRole('button', { name: 'Connect WhatsApp' }).click();
  await expect(page.getByAltText('WhatsApp Web QR Code')).toBeVisible({ timeout: 5000 });
  await expect(
    page.getByText('Open WhatsApp on your phone, go to Linked Devices, tap Link a Device, and scan this QR code.'),
  ).toBeVisible();

  // Simulate phone scanning QR
  await page.request.post('http://127.0.0.1:4199/__e2e/wa-scan-qr');
  await expect(page.getByText('+923001112233')).toBeVisible({ timeout: 5000 });

  // Configure main WhatsApp number & send test notification
  await page.getByLabel('Send email alerts to this WhatsApp number').fill('+923009998877');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('WhatsApp notification preferences saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Send Test Notification', exact: true }).click();
  await expect(page.getByText(/Test notification sent/)).toBeVisible();

  // Simulate incoming reply while connected -> creates and delivers WhatsApp alert
  const replyRes = await page.request.post('http://127.0.0.1:4199/__e2e/simulate-incoming-reply');
  const replyJson = await replyRes.json();
  expect(replyJson.syncRes.replies).toBe(1);
  expect(replyJson.sentAlerts.length).toBeGreaterThanOrEqual(2);

  // Simulate failure + manual Retry button in UI
  await page.request.post('http://127.0.0.1:4199/__e2e/fail-next-wa-send');
  await page.getByRole('button', { name: 'Send Test Notification', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
  await expect(page.getByText('Notification retry processed.')).toBeVisible();

  // Disconnect WhatsApp & verify incoming email still persists and queues alert safely
  await page.getByRole('button', { name: 'Disconnect WhatsApp', exact: true }).click();
  await expect(page.getByText('DISCONNECTED', { exact: true }).first()).toBeVisible();

  const offlineReplyRes = await page.request.post('http://127.0.0.1:4199/__e2e/simulate-incoming-reply');
  const offlineReplyJson = await offlineReplyRes.json();
  expect(offlineReplyJson.syncRes.replies).toBe(1);
  await page.reload();
  await expect(page.getByRole('table').getByText('PENDING', { exact: true }).first()).toBeVisible();
});

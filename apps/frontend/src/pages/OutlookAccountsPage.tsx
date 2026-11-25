import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Unplug,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  statusTone,
} from '../components/ui';

export interface OutlookAccountDto {
  id: string;
  email: string;
  displayName: string | null;
  accountType: string;
  connectionStatus: string;
  authorizationStatus: string;
  lastError: string | null;
  isPaused: boolean;
  dailySendLimit: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  scheduleStartTime: string;
  scheduleEndTime: string;
  timezone: string;
  allowedWeekdays: number[];
  signatureHtml: string | null;
  signatureEnabled: boolean;
  whatsappNotificationsEnabled: boolean;
  lastActivityAt: string | null;
  stats: {
    sentToday: number;
    remainingToday: number;
    leadsAssigned: number;
    activeCampaigns: number;
    emailsSent: number;
    confirmedDeliveries: number;
    bounces: number;
    opens: number;
    clicks: number;
    replies: number;
  };
}

const WEEKDAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
];

export function OutlookAccountsPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<OutlookAccountDto | null>(null);
  const [disconnectAccount, setDisconnectAccount] = useState<OutlookAccountDto | null>(null);
  const [testEmailAccount, setTestEmailAccount] = useState<OutlookAccountDto | null>(null);
  const [testRecipient, setTestRecipient] = useState('');
  const [showSigPreview, setShowSigPreview] = useState(false);

  // Edit form state
  const [formState, setFormState] = useState({
    dailySendLimit: 50,
    minDelayMinutes: 15,
    maxDelayMinutes: 25,
    scheduleStartTime: '09:00',
    scheduleEndTime: '17:00',
    timezone: 'UTC',
    allowedWeekdays: [1, 2, 3, 4, 5],
    signatureHtml: '',
    signatureEnabled: false,
    whatsappNotificationsEnabled: true,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () =>
      apiRequest<{ oauthConfigured: boolean; accounts: OutlookAccountDto[] }>('/api/accounts'),
  });

  const connectMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ url: string }>('/api/accounts/connect-url', { method: 'POST', json: {} }),
    onSuccess: (res) => {
      window.location.href = res.url;
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: typeof formState }) =>
      apiRequest(`/api/accounts/${id}`, { method: 'PATCH', json: payload }),
    onSuccess: () => {
      setEditingAccount(null);
      setActionMessage('Account settings updated successfully.');
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const pauseResumeMutation = useMutation({
    mutationFn: ({ id, pause }: { id: string; pause: boolean }) =>
      apiRequest(`/api/accounts/${id}/${pause ? 'pause' : 'resume'}`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['accounts'] }),
    onError: (err) => setActionError((err as Error).message),
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/accounts/${id}/disconnect`, { method: 'POST' }),
    onSuccess: () => {
      setDisconnectAccount(null);
      setActionMessage('Outlook account disconnected. Historical leads, campaigns, and activity were preserved.');
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const syncMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ processed: number; replies: number; bounces: number }>(`/api/accounts/${id}/sync-inbox`, {
        method: 'POST',
      }),
    onSuccess: (res) => {
      setActionMessage(`Inbox synced: ${res.processed} new messages, ${res.replies} replies, ${res.bounces} bounces.`);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const testEmailMutation = useMutation({
    mutationFn: ({ id, recipientEmail }: { id: string; recipientEmail: string }) =>
      apiRequest(`/api/accounts/${id}/test-email`, {
        method: 'POST',
        json: { recipientEmail: recipientEmail || undefined },
      }),
    onSuccess: () => {
      setTestEmailAccount(null);
      setActionMessage('Test email accepted by Microsoft Graph.');
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const openEditModal = (acc: OutlookAccountDto) => {
    setActionError(null);
    setShowSigPreview(false);
    setFormState({
      dailySendLimit: acc.dailySendLimit,
      minDelayMinutes: acc.minDelayMinutes,
      maxDelayMinutes: acc.maxDelayMinutes,
      scheduleStartTime: acc.scheduleStartTime,
      scheduleEndTime: acc.scheduleEndTime,
      timezone: acc.timezone,
      allowedWeekdays: acc.allowedWeekdays,
      signatureHtml: acc.signatureHtml || '',
      signatureEnabled: acc.signatureEnabled,
      whatsappNotificationsEnabled: acc.whatsappNotificationsEnabled,
    });
    setEditingAccount(acc);
  };

  const toggleWeekday = (day: number) => {
    setFormState((prev) => {
      const exists = prev.allowedWeekdays.includes(day);
      const next = exists
        ? prev.allowedWeekdays.filter((d) => d !== day)
        : [...prev.allowedWeekdays, day].sort();
      return { ...prev, allowedWeekdays: next };
    });
  };

  const connectedParam = searchParams.get('connected');
  const oauthErrParam = searchParams.get('oauth_error');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Connected Outlook Accounts</h2>
          <p className="text-xs text-slate-500">
            Each Outlook account maintains isolated sending limits, pacing intervals, schedules, leads, and analytics.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={connectMutation.isPending}
          onClick={() => connectMutation.mutate()}
        >
          <Plus className="h-4 w-4" />
          <span>Connect Outlook Account</span>
        </Button>
      </div>

      {connectedParam && (
        <Alert tone="success" title="Outlook account connected">
          Successfully authorized <strong>{connectedParam}</strong> via Microsoft OAuth 2.0.
        </Alert>
      )}
      {oauthErrParam && (
        <Alert tone="danger" title="Microsoft authorization notice">
          {oauthErrParam}
        </Alert>
      )}
      {data && !data.oauthConfigured && (
        <Alert tone="warning" title="Microsoft OAuth configuration required">
          Configure your Azure App Registration client ID, client secret, and redirect URI on the backend server (see{' '}
          <code>docs/MICROSOFT_OAUTH_SETUP.md</code>) before connecting real Outlook accounts.
        </Alert>
      )}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {actionMessage && <Alert tone="success">{actionMessage}</Alert>}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : !data || data.accounts.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No Outlook accounts connected"
          description="Connect one or more personal Outlook or Microsoft 365 accounts using Microsoft OAuth 2.0 PKCE. Passwords are never requested or stored."
          action={
            <Button variant="secondary" onClick={() => connectMutation.mutate()}>
              <Plus className="h-4 w-4" />
              <span>Connect Outlook Account</span>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {data.accounts.map((acc) => (
            <Card key={acc.id}>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900">{acc.email}</h3>
                      <Badge tone={statusTone(acc.connectionStatus)}>{acc.connectionStatus}</Badge>
                      <Badge tone={statusTone(acc.authorizationStatus)}>{acc.authorizationStatus}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {acc.displayName || 'Outlook Mailbox'} • {acc.accountType} • {acc.timezone} ({acc.scheduleStartTime}–{acc.scheduleEndTime}) • Delay {acc.minDelayMinutes}–{acc.maxDelayMinutes}m
                    </p>
                  </div>
                  {acc.isPaused && <Badge tone="warning">Sending Paused</Badge>}
                </div>

                {acc.lastError && <Alert tone="danger">{acc.lastError}</Alert>}

                {/* Metrics Grid */}
                <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs sm:grid-cols-5">
                  <div>
                    <p className="text-[11px] text-slate-500">Daily Limit</p>
                    <p className="font-semibold text-slate-900">{acc.dailySendLimit}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Sent Today</p>
                    <p className="font-semibold text-slate-900">{acc.stats.sentToday}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Remaining</p>
                    <p className="font-semibold text-indigo-700">{acc.stats.remainingToday}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Leads</p>
                    <p className="font-semibold text-slate-900">{acc.stats.leadsAssigned}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Active Camp.</p>
                    <p className="font-semibold text-slate-900">{acc.stats.activeCampaigns}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Total Sent</p>
                    <p className="font-semibold text-slate-900">{acc.stats.emailsSent}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Confirmed Deliv.</p>
                    <p className="font-semibold text-emerald-700">{acc.stats.confirmedDeliveries}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Bounces</p>
                    <p className="font-semibold text-rose-700">{acc.stats.bounces}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Opens / Clicks</p>
                    <p className="font-semibold text-slate-900">{acc.stats.opens} / {acc.stats.clicks}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Replies</p>
                    <p className="font-semibold text-emerald-700">{acc.stats.replies}</p>
                  </div>
                </div>

                <p className="text-[11px] text-slate-500">
                  Last activity: {acc.lastActivityAt ? new Date(acc.lastActivityAt).toLocaleString() : 'Never'}
                </p>

                {/* Actions */}
                <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <Button size="sm" variant="outline" onClick={() => openEditModal(acc)}>
                    <Settings2 className="h-3.5 w-3.5" />
                    <span>Edit Settings</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => pauseResumeMutation.mutate({ id: acc.id, pause: !acc.isPaused })}
                  >
                    {acc.isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                    <span>{acc.isPaused ? 'Resume' : 'Pause'}</span>
                  </Button>
                  {acc.connectionStatus === 'CONNECTED' ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={syncMutation.isPending}
                        onClick={() => syncMutation.mutate(acc.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Sync Inbox</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setTestRecipient('');
                          setTestEmailAccount(acc);
                        }}
                      >
                        <Send className="h-3.5 w-3.5" />
                        <span>Test Email</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-rose-600 hover:bg-rose-50"
                        onClick={() => setDisconnectAccount(acc)}
                      >
                        <Unplug className="h-3.5 w-3.5" />
                        <span>Disconnect</span>
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => connectMutation.mutate()}>
                      Reauthorize
                    </Button>
                  )}
                </div>

                <div className="flex flex-wrap gap-3 text-xs font-medium text-indigo-600">
                  <Link to={`/leads?accountId=${acc.id}`} className="hover:underline">View Leads</Link>
                  <Link to={`/campaigns?accountId=${acc.id}`} className="hover:underline">View Campaigns</Link>
                  <Link to={`/analytics?accountId=${acc.id}`} className="hover:underline">View Analytics</Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Account Settings Modal */}
      <Modal
        open={Boolean(editingAccount)}
        onClose={() => setEditingAccount(null)}
        title={`Configure ${editingAccount?.email || ''}`}
        description="Settings apply independently to this Outlook account only."
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Daily Sending Limit</label>
              <Input
                type="number"
                min={1}
                max={2000}
                value={formState.dailySendLimit}
                onChange={(e) => setFormState((s) => ({ ...s, dailySendLimit: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Min Delay (Minutes)</label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={formState.minDelayMinutes}
                onChange={(e) => setFormState((s) => ({ ...s, minDelayMinutes: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Max Delay (Minutes)</label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={formState.maxDelayMinutes}
                onChange={(e) => setFormState((s) => ({ ...s, maxDelayMinutes: Number(e.target.value) }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Start Time</label>
              <Input
                type="time"
                value={formState.scheduleStartTime}
                onChange={(e) => setFormState((s) => ({ ...s, scheduleStartTime: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">End Time</label>
              <Input
                type="time"
                value={formState.scheduleEndTime}
                onChange={(e) => setFormState((s) => ({ ...s, scheduleEndTime: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Time Zone</label>
              <Select
                value={formState.timezone}
                onChange={(e) => setFormState((s) => ({ ...s, timezone: e.target.value }))}
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-700">Allowed Weekdays</label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => {
                const active = formState.allowedWeekdays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleWeekday(day.value)}
                    className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                      active
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-600'
                    }`}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={formState.signatureEnabled}
                  onChange={(e) => setFormState((s) => ({ ...s, signatureEnabled: e.target.checked }))}
                />
                <span>Append email signature when sending</span>
              </label>
              <button
                type="button"
                className="text-xs font-medium text-indigo-600 hover:underline"
                onClick={() => setShowSigPreview((v) => !v)}
              >
                {showSigPreview ? 'Edit Signature' : 'Preview Signature'}
              </button>
            </div>
            {showSigPreview ? (
              <div
                className="min-h-24 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"
                dangerouslySetInnerHTML={{ __html: formState.signatureHtml || '<p class="text-slate-400">No signature configured</p>' }}
              />
            ) : (
              <Textarea
                rows={4}
                placeholder="<p>Best regards,<br/>Your Name</p>"
                value={formState.signatureHtml}
                onChange={(e) => setFormState((s) => ({ ...s, signatureHtml: e.target.value }))}
              />
            )}
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={formState.whatsappNotificationsEnabled}
              onChange={(e) =>
                setFormState((s) => ({ ...s, whatsappNotificationsEnabled: e.target.checked }))
              }
            />
            <span>Generate WhatsApp notifications for incoming emails &amp; replies on this account</span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditingAccount(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={updateMutation.isPending}
              onClick={() =>
                editingAccount && updateMutation.mutate({ id: editingAccount.id, payload: formState })
              }
            >
              {updateMutation.isPending ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Disconnect Confirmation */}
      <Modal
        open={Boolean(disconnectAccount)}
        onClose={() => setDisconnectAccount(null)}
        title="Disconnect Outlook Account?"
        description="OAuth tokens will be cleared and active campaigns for this account paused. Historical leads, campaigns, and email analytics remain preserved."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDisconnectAccount(null)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={disconnectMutation.isPending}
            onClick={() => disconnectAccount && disconnectMutation.mutate(disconnectAccount.id)}
          >
            Disconnect Account
          </Button>
        </div>
      </Modal>

      {/* Send Test Email */}
      <Modal
        open={Boolean(testEmailAccount)}
        onClose={() => setTestEmailAccount(null)}
        title={`Send Test Email (${testEmailAccount?.email || ''})`}
        description="Enter your own verified email address to confirm Microsoft Graph sending."
      >
        <div className="space-y-4">
          <Input
            type="email"
            placeholder="Leave blank to use verified Test Mode recipient, or enter email"
            value={testRecipient}
            onChange={(e) => setTestRecipient(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setTestEmailAccount(null)}>Cancel</Button>
            <Button
              variant="secondary"
              disabled={testEmailMutation.isPending}
              onClick={() =>
                testEmailAccount &&
                testEmailMutation.mutate({ id: testEmailAccount.id, recipientEmail: testRecipient })
              }
            >
              Send Test Email
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Copy,
  Download,
  Eye,
  Pause,
  Play,
  Plus,
  Send,
  Square,
} from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
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
  statusTone,
} from '../components/ui';
import type { OutlookAccountDto } from './OutlookAccountsPage';

interface CampaignDto {
  id: string;
  name: string;
  outlookAccountId: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  confirmedFirstSend: boolean;
  isTestMode: boolean;
  useAccountDefaults: boolean;
  effectiveDailyLimit: number;
  effectiveMinDelayMinutes: number;
  effectiveMaxDelayMinutes: number;
  outlookAccount: {
    id: string;
    email: string;
    connectionStatus: string;
    scheduleStartTime: string;
    scheduleEndTime: string;
    timezone: string;
  };
  metrics: {
    totalLeads: number;
    emailsSent: number;
    confirmedDeliveries: number;
    bounces: number;
    opens: number;
    clicks: number;
    replies: number;
    failures: number;
    pendingJobs: number;
  };
}

interface PreviewResponse {
  campaignId: string;
  campaignName: string;
  outlookEmail: string;
  totalLeads: number;
  invalidLeadsCount: number;
  previews: Array<{
    leadId: string;
    recipientEmail: string;
    status: string;
    subject: string;
    htmlPreview: string;
    missingVariables: string[];
    isValid: boolean;
  }>;
}

export function CampaignsPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [filterAccountId, setFilterAccountId] = useState(searchParams.get('accountId') || '');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    outlookAccountId: '',
    isTestMode: false,
    useAccountDefaults: true,
    endDate: '',
    leadIds: [] as string[],
  });

  const [previewCampaignId, setPreviewCampaignId] = useState<string | null>(null);
  const [confirmStartCampaign, setConfirmStartCampaign] = useState<CampaignDto | null>(null);
  const [confirmStopCampaign, setConfirmStopCampaign] = useState<CampaignDto | null>(null);

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => apiRequest<{ accounts: OutlookAccountDto[] }>('/api/accounts'),
  });

  const { data: campaignsData, isLoading } = useQuery({
    queryKey: ['campaigns', filterAccountId],
    queryFn: () => {
      const qs = filterAccountId ? `?outlookAccountId=${encodeURIComponent(filterAccountId)}` : '';
      return apiRequest<{ campaigns: CampaignDto[] }>(`/api/campaigns${qs}`);
    },
    refetchInterval: 15_000,
  });

  const { data: accountLeadsData } = useQuery({
    queryKey: ['account-available-leads', createForm.outlookAccountId],
    enabled: Boolean(createOpen && createForm.outlookAccountId),
    queryFn: () =>
      apiRequest<{ leads: Array<{ id: string; email: string; company: string | null; subject: string; campaignId: string | null; status: string }> }>(
        `/api/leads?outlookAccountId=${encodeURIComponent(createForm.outlookAccountId)}&pageSize=100`,
      ),
  });

  const { data: previewData, isLoading: previewLoading } = useQuery({
    queryKey: ['campaign-preview', previewCampaignId],
    enabled: Boolean(previewCampaignId),
    queryFn: () => apiRequest<PreviewResponse>(`/api/campaigns/${previewCampaignId}/preview`),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest('/api/campaigns', {
        method: 'POST',
        json: {
          name: createForm.name,
          outlookAccountId: createForm.outlookAccountId,
          leadIds: createForm.leadIds,
          isTestMode: createForm.isTestMode,
          useAccountDefaults: createForm.useAccountDefaults,
          endDate: createForm.endDate ? new Date(`${createForm.endDate}T23:59:59Z`).toISOString() : null,
        },
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setCreateForm({ name: '', outlookAccountId: '', isTestMode: false, useAccountDefaults: true, endDate: '', leadIds: [] });
      setSuccessMsg('Campaign created.');
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'start' | 'pause' | 'resume' | 'stop' | 'duplicate'; body?: unknown }) =>
      apiRequest(`/api/campaigns/${id}/${action}`, { method: 'POST', json: body ?? {} }),
    onSuccess: () => {
      setConfirmStartCampaign(null);
      setConfirmStopCampaign(null);
      setErrorMsg(null);
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => {
      setConfirmStartCampaign(null);
      setConfirmStopCampaign(null);
      setErrorMsg((err as Error).message);
    },
  });

  const accounts = accountsData?.accounts || [];
  const campaigns = campaignsData?.campaigns || [];
  const selectableLeads = (accountLeadsData?.leads || []).filter((l) => !l.campaignId && l.status === 'VALIDATED');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Outreach Campaigns</h2>
          <p className="text-xs text-slate-500">
            Campaigns run in the background strictly using the selected Outlook account’s lead list, limits, and schedule.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-56" value={filterAccountId} onChange={(e) => setFilterAccountId(e.target.value)}>
            <option value="">All Outlook Accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.email}</option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            <span>Create Campaign</span>
          </Button>
        </div>
      </div>

      {errorMsg && <Alert tone="danger">{errorMsg}</Alert>}
      {successMsg && <Alert tone="success">{successMsg}</Alert>}

      {isLoading ? (
        <Skeleton className="h-64" />
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={Send}
          title="No campaigns yet"
          description="Upload leads for an Outlook account, then create a campaign to preview personalized emails and launch automated sending."
          action={
            <Button variant="secondary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span>Create Campaign</span>
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900">{c.name}</h3>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                      {c.isTestMode && <Badge tone="warning">Test Mode</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Account: <strong>{c.outlookAccount.email}</strong> ({c.outlookAccount.connectionStatus}) • Limit: {c.effectiveDailyLimit}/day • Delay: {c.effectiveMinDelayMinutes}–{c.effectiveMaxDelayMinutes}m • Window: {c.outlookAccount.scheduleStartTime}–{c.outlookAccount.scheduleEndTime} ({c.outlookAccount.timezone})
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setPreviewCampaignId(c.id)}>
                      <Eye className="h-3.5 w-3.5" />
                      <span>Preview</span>
                    </Button>
                    {c.status === 'DRAFT' && (
                      <Button size="sm" variant="secondary" onClick={() => setConfirmStartCampaign(c)}>
                        <Play className="h-3.5 w-3.5" />
                        <span>Start</span>
                      </Button>
                    )}
                    {c.status === 'ACTIVE' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => actionMutation.mutate({ id: c.id, action: 'pause' })}
                      >
                        <Pause className="h-3.5 w-3.5" />
                        <span>Pause</span>
                      </Button>
                    )}
                    {c.status === 'PAUSED' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => actionMutation.mutate({ id: c.id, action: 'resume' })}
                      >
                        <Play className="h-3.5 w-3.5" />
                        <span>Resume</span>
                      </Button>
                    )}
                    {(c.status === 'ACTIVE' || c.status === 'PAUSED') && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-rose-600 hover:bg-rose-50"
                        onClick={() => setConfirmStopCampaign(c)}
                      >
                        <Square className="h-3.5 w-3.5" />
                        <span>Stop</span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => actionMutation.mutate({ id: c.id, action: 'duplicate' })}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>Duplicate</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => downloadWithAuth(`/api/campaigns/${c.id}/export`, `campaign-${c.id}-report.csv`)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export Report</span>
                    </Button>
                    <Link
                      to={`/analytics?campaignId=${c.id}`}
                      className="inline-flex h-8 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Analytics
                    </Link>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs sm:grid-cols-9">
                  <div>
                    <p className="text-[11px] text-slate-500">Leads</p>
                    <p className="font-semibold text-slate-900">{c.metrics.totalLeads}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Queued</p>
                    <p className="font-semibold text-slate-900">{c.metrics.pendingJobs}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Sent</p>
                    <p className="font-semibold text-slate-900">{c.metrics.emailsSent}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Confirmed</p>
                    <p className="font-semibold text-emerald-700">{c.metrics.confirmedDeliveries}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Bounces</p>
                    <p className="font-semibold text-rose-700">{c.metrics.bounces}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Opens</p>
                    <p className="font-semibold text-slate-900">{c.metrics.opens}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Clicks</p>
                    <p className="font-semibold text-slate-900">{c.metrics.clicks}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Replies</p>
                    <p className="font-semibold text-emerald-700">{c.metrics.replies}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Failures</p>
                    <p className="font-semibold text-rose-700">{c.metrics.failures}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Campaign Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Outreach Campaign"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Campaign Name</label>
            <Input
              placeholder="e.g., Q1 Agency Outreach"
              value={createForm.name}
              onChange={(e) => setCreateForm((s) => ({ ...s, name: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Assigned Outlook Account</label>
              <Select
                value={createForm.outlookAccountId}
                onChange={(e) => setCreateForm((s) => ({ ...s, outlookAccountId: e.target.value, leadIds: [] }))}
              >
                <option value="">Select Outlook account...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.email} ({a.connectionStatus})</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Optional End Date</label>
              <Input
                type="date"
                value={createForm.endDate}
                onChange={(e) => setCreateForm((s) => ({ ...s, endDate: e.target.value }))}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={createForm.isTestMode}
              onChange={(e) => setCreateForm((s) => ({ ...s, isTestMode: e.target.checked }))}
            />
            <span>Run this campaign in Test Mode (sends strictly to your verified Test Mode email address)</span>
          </label>

          {createForm.outlookAccountId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-700">
                  Select Validated Unassigned Leads ({selectableLeads.length} available)
                </label>
                <button
                  type="button"
                  className="text-xs font-medium text-indigo-600 hover:underline"
                  onClick={() =>
                    setCreateForm((s) => ({
                      ...s,
                      leadIds:
                        s.leadIds.length === selectableLeads.length ? [] : selectableLeads.map((l) => l.id),
                    }))
                  }
                >
                  {createForm.leadIds.length === selectableLeads.length ? 'Clear All' : 'Select All'}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 p-2 text-xs">
                {selectableLeads.length === 0 ? (
                  <p className="p-2 text-slate-500">No unassigned validated leads for this account yet.</p>
                ) : (
                  selectableLeads.map((l) => (
                    <label key={l.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={createForm.leadIds.includes(l.id)}
                        onChange={(e) =>
                          setCreateForm((s) => ({
                            ...s,
                            leadIds: e.target.checked
                              ? [...s.leadIds, l.id]
                              : s.leadIds.filter((x) => x !== l.id),
                          }))
                        }
                      />
                      <span className="font-medium text-slate-800">{l.email}</span>
                      <span className="truncate text-slate-500">— {l.subject}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              variant="secondary"
              disabled={!createForm.name || !createForm.outlookAccountId || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Creating...' : 'Create Campaign'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Personalized Email Preview Modal */}
      <Modal
        open={Boolean(previewCampaignId)}
        onClose={() => setPreviewCampaignId(null)}
        title={`Campaign Preview: ${previewData?.campaignName || ''}`}
        description={`Sender: ${previewData?.outlookEmail || ''}`}
        maxWidth="max-w-3xl"
      >
        {previewLoading ? (
          <Skeleton className="h-48" />
        ) : previewData ? (
          <div className="space-y-4">
            {previewData.invalidLeadsCount > 0 && (
              <Alert tone="danger">
                {previewData.invalidLeadsCount} lead(s) have missing personalization variables and cannot be sent until fixed.
              </Alert>
            )}
            {previewData.previews.map((p) => (
              <div key={p.leadId} className="space-y-2 rounded-lg border border-slate-200 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-900">To: {p.recipientEmail}</span>
                  <Badge tone={p.isValid ? 'success' : 'danger'}>
                    {p.isValid ? 'Valid' : `Missing: ${p.missingVariables.join(', ')}`}
                  </Badge>
                </div>
                <p className="text-xs font-medium text-slate-700">Subject: {p.subject}</p>
                <div
                  className="rounded-md border border-slate-100 bg-slate-50 p-3 text-sm text-slate-800"
                  dangerouslySetInnerHTML={{ __html: p.htmlPreview }}
                />
              </div>
            ))}
          </div>
        ) : null}
      </Modal>

      {/* First Email Send Confirmation */}
      <Modal
        open={Boolean(confirmStartCampaign)}
        onClose={() => setConfirmStartCampaign(null)}
        title="Confirm Campaign Launch"
        description={`Confirm before dispatching the first email for "${confirmStartCampaign?.name || ''}".`}
      >
        <div className="space-y-4 text-xs text-slate-600">
          <p>
            Sender Outlook account: <strong>{confirmStartCampaign?.outlookAccount.email}</strong>
          </p>
          <p>
            Mode: <strong>{confirmStartCampaign?.isTestMode ? 'Test Mode (verified recipient only)' : 'Live Personalized Outreach'}</strong>
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmStartCampaign(null)}>Cancel</Button>
            <Button
              variant="secondary"
              disabled={actionMutation.isPending}
              onClick={() =>
                confirmStartCampaign &&
                actionMutation.mutate({
                  id: confirmStartCampaign.id,
                  action: 'start',
                  body: { confirmFirstSend: true },
                })
              }
            >
              Confirm &amp; Start Campaign
            </Button>
          </div>
        </div>
      </Modal>

      {/* Stop Campaign Confirmation */}
      <Modal
        open={Boolean(confirmStopCampaign)}
        onClose={() => setConfirmStopCampaign(null)}
        title="Stop Campaign?"
        description="Stopping cancels all pending sending jobs for this campaign without affecting other campaigns."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmStopCampaign(null)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={actionMutation.isPending}
            onClick={() =>
              confirmStopCampaign && actionMutation.mutate({ id: confirmStopCampaign.id, action: 'stop' })
            }
          >
            Stop Campaign
          </Button>
        </div>
      </Modal>
    </div>
  );
}

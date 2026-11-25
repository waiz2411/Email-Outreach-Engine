import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Download, RefreshCw } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  Input,
  Select,
  statusTone,
} from '../components/ui';
import type { OutlookAccountDto } from './OutlookAccountsPage';

interface EmailMessageDto {
  id: string;
  recipientEmail: string;
  subject: string;
  isTestEmail: boolean;
  status: string;
  deliveryStatus: string;
  deliverySource: string;
  bounceType: string;
  openCount: number;
  clickCount: number;
  sentAt: string | null;
  repliedAt: string | null;
  graphMessageId: string | null;
  errorMessage: string | null;
  outlookAccount: { id: string; email: string };
  campaign: { id: string; name: string } | null;
}

export function EmailActivityPage() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => apiRequest<{ accounts: OutlookAccountDto[] }>('/api/accounts'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['emails', accountId, status, search, page],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (accountId) qs.set('outlookAccountId', accountId);
      if (status) qs.set('status', status);
      if (search) qs.set('search', search);
      qs.set('page', String(page));
      return apiRequest<{
        emails: EmailMessageDto[];
        uncertainJobs: Array<{
          id: string;
          recipientEmail: string;
          lastError: string | null;
          outlookAccount: { email: string };
          campaign: { name: string };
        }>;
        pagination: { page: number; totalPages: number; total: number };
      }>(`/api/emails?${qs.toString()}`);
    },
    refetchInterval: 15_000,
  });

  const reconcileMutation = useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<{ outcome: string }>(`/api/jobs/${jobId}/reconcile`, { method: 'POST' }),
    onSuccess: (res) => {
      setReconcileMsg(`Reconciliation result: ${res.outcome}`);
      void queryClient.invalidateQueries({ queryKey: ['emails'] });
    },
  });

  return (
    <div className="space-y-6">
      {reconcileMsg && <Alert tone="info">{reconcileMsg}</Alert>}

      {data && data.uncertainJobs.length > 0 && (
        <Alert tone="warning" title={`${data.uncertainJobs.length} uncertain send job(s) need reconciliation`}>
          <div className="mt-2 space-y-2">
            {data.uncertainJobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-white/80 px-3 py-2 text-xs">
                <span>
                  <strong>{j.recipientEmail}</strong> via {j.outlookAccount.email} ({j.campaign.name}) — {j.lastError}
                </span>
                <Button size="sm" variant="outline" onClick={() => reconcileMutation.mutate(j.id)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Reconcile Safely</span>
                </Button>
              </div>
            ))}
          </div>
        </Alert>
      )}

      <Card>
        <CardHeader
          title={`Email Activity Log (${data?.pagination.total ?? 0})`}
          description="Microsoft Graph accepts sends asynchronously (202 Accepted). Emails remain 'Delivery Unknown' unless a DSN receipt or recipient reply confirms delivery."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const qs = new URLSearchParams();
                if (accountId) qs.set('outlookAccountId', accountId);
                downloadWithAuth(`/api/emails/export?${qs.toString()}`, 'email-activity-export.csv');
              }}
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Activity CSV</span>
            </Button>
          }
        />
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              placeholder="Search recipient or subject..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
            <Select
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Outlook Accounts</option>
              {(accountsData?.accounts || []).map((a) => (
                <option key={a.id} value={a.id}>{a.email}</option>
              ))}
            </Select>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Statuses</option>
              {['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'DELIVERY_UNKNOWN', 'BOUNCED', 'FAILED', 'OPENED', 'CLICKED', 'REPLIED'].map(
                (st) => (
                  <option key={st} value={st}>{st}</option>
                ),
              )}
            </Select>
          </div>

          {isLoading ? (
            <p className="text-xs text-slate-500">Loading activity...</p>
          ) : !data || data.emails.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No email activity yet"
              description="Sent campaign messages and test emails will appear here with full provider status and event tracking."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">Recipient</th>
                    <th className="px-3 py-2.5">Sender / Campaign</th>
                    <th className="px-3 py-2.5">Subject</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Delivery Truth</th>
                    <th className="px-3 py-2.5">Events</th>
                    <th className="px-3 py-2.5">Sent At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {data.emails.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{m.recipientEmail}</p>
                        {m.isTestEmail && <Badge tone="warning" className="mt-0.5">Test</Badge>}
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-slate-700">{m.outlookAccount.email}</p>
                        <p className="text-[11px] text-slate-400">{m.campaign?.name || 'Direct Test'}</p>
                      </td>
                      <td className="max-w-xs truncate px-3 py-2.5 text-slate-800">{m.subject}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={statusTone(m.status)}>{m.status}</Badge>
                        {m.errorMessage && (
                          <p className="mt-1 max-w-xs truncate text-[11px] text-rose-600">{m.errorMessage}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={statusTone(m.deliveryStatus)}>{m.deliveryStatus}</Badge>
                        {m.bounceType !== 'NONE' && (
                          <span className="ml-1 text-[11px] text-rose-600">({m.bounceType})</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">
                        O:{m.openCount} C:{m.clickCount} {m.repliedAt ? '• Replied' : ''}
                      </td>
                      <td className="px-3 py-2.5 text-slate-500">
                        {m.sentAt ? new Date(m.sentAt).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>Page {data.pagination.page} of {data.pagination.totalPages}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button size="sm" variant="outline" disabled={page >= data.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

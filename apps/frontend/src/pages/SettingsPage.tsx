import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, KeyRound, Save } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Skeleton,
} from '../components/ui';

interface SettingsDto {
  globalPaused: boolean;
  testMode: boolean;
  testModeRecipientEmail: string | null;
  openTrackingEnabled: boolean;
  clickTrackingEnabled: boolean;
  unsubscribeFooterEnabled: boolean;
  maxCampaignSize: number;
  maxSendRetries: number;
  publicBaseUrl: string | null;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [form, setForm] = useState<SettingsDto>({
    globalPaused: false,
    testMode: false,
    testModeRecipientEmail: '',
    openTrackingEnabled: true,
    clickTrackingEnabled: true,
    unsubscribeFooterEnabled: true,
    maxCampaignSize: 5000,
    maxSendRetries: 3,
    publicBaseUrl: '',
  });

  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiRequest<{ settings: SettingsDto }>('/api/settings'),
  });

  const { data: logsData } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () =>
      apiRequest<{
        logs: Array<{ id: string; action: string; entityType: string; entityId: string | null; createdAt: string }>;
      }>('/api/audit-logs'),
  });

  useEffect(() => {
    if (data?.settings) {
      setForm({
        ...data.settings,
        testModeRecipientEmail: data.settings.testModeRecipientEmail || '',
        publicBaseUrl: data.settings.publicBaseUrl || '',
      });
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest('/api/settings', {
        method: 'PATCH',
        json: {
          ...form,
          testModeRecipientEmail: form.testModeRecipientEmail?.trim() || null,
          publicBaseUrl: form.publicBaseUrl?.trim() || null,
        },
      }),
    onSuccess: () => {
      setErrMsg(null);
      setMsg('System settings saved.');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => setErrMsg((err as Error).message),
  });

  const passwordMutation = useMutation({
    mutationFn: () => apiRequest('/api/auth/change-password', { method: 'POST', json: pwForm }),
    onSuccess: () => {
      setPwForm({ currentPassword: '', newPassword: '' });
      setErrMsg(null);
      setMsg('Administrator password updated.');
    },
    onError: (err) => setErrMsg((err as Error).message),
  });

  if (isLoading) return <Skeleton className="h-72" />;

  return (
    <div className="space-y-6">
      {errMsg && <Alert tone="danger">{errMsg}</Alert>}
      {msg && <Alert tone="success">{msg}</Alert>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Engine &amp; Safety Controls" />
          <CardContent className="space-y-4 text-xs">
            <label className="flex items-center gap-2 font-medium text-slate-800">
              <input
                type="checkbox"
                checked={form.globalPaused}
                onChange={(e) => setForm((s) => ({ ...s, globalPaused: e.target.checked }))}
              />
              <span>Global Pause (halt all outbound campaign sending)</span>
            </label>

            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <label className="flex items-center gap-2 font-medium text-amber-900">
                <input
                  type="checkbox"
                  checked={form.testMode}
                  onChange={(e) => setForm((s) => ({ ...s, testMode: e.target.checked }))}
                />
                <span>Enable Test Mode (routes all sends strictly to your verified email below)</span>
              </label>
              <Input
                type="email"
                placeholder="Verified test recipient email (e.g. you@outlook.com)"
                value={form.testModeRecipientEmail || ''}
                onChange={(e) => setForm((s) => ({ ...s, testModeRecipientEmail: e.target.value }))}
              />
            </div>

            <div className="space-y-2 border-t border-slate-100 pt-3">
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={form.openTrackingEnabled}
                  onChange={(e) => setForm((s) => ({ ...s, openTrackingEnabled: e.target.checked }))}
                />
                <span>Enable HTML Open Tracking Pixel (estimates only; affected by privacy image blocking/scanners)</span>
              </label>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={form.clickTrackingEnabled}
                  onChange={(e) => setForm((s) => ({ ...s, clickTrackingEnabled: e.target.checked }))}
                />
                <span>Enable Signed Click Tracking Links</span>
              </label>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={form.unsubscribeFooterEnabled}
                  onChange={(e) => setForm((s) => ({ ...s, unsubscribeFooterEnabled: e.target.checked }))}
                />
                <span>Include Unsubscribe Footer Link</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <div>
                <label className="mb-1 block font-medium text-slate-700">Max Campaign Size</label>
                <Input
                  type="number"
                  value={form.maxCampaignSize}
                  onChange={(e) => setForm((s) => ({ ...s, maxCampaignSize: Number(e.target.value) }))}
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-slate-700">Max Send Retries</label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={form.maxSendRetries}
                  onChange={(e) => setForm((s) => ({ ...s, maxSendRetries: Number(e.target.value) }))}
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block font-medium text-slate-700">Public Base URL (for tracking &amp; webhooks)</label>
              <Input
                placeholder="https://your-service.onrender.com"
                value={form.publicBaseUrl || ''}
                onChange={(e) => setForm((s) => ({ ...s, publicBaseUrl: e.target.value }))}
              />
            </div>

            <Button variant="secondary" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              <Save className="h-4 w-4" />
              <span>{saveMutation.isPending ? 'Saving...' : 'Save Settings'}</span>
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Change Administrator Password" />
            <CardContent className="space-y-3">
              <Input
                type="password"
                placeholder="Current password"
                value={pwForm.currentPassword}
                onChange={(e) => setPwForm((s) => ({ ...s, currentPassword: e.target.value }))}
              />
              <Input
                type="password"
                placeholder="New strong password (12+ chars, upper/lower/number)"
                value={pwForm.newPassword}
                onChange={(e) => setPwForm((s) => ({ ...s, newPassword: e.target.value }))}
              />
              <Button
                variant="outline"
                disabled={!pwForm.currentPassword || !pwForm.newPassword || passwordMutation.isPending}
                onClick={() => passwordMutation.mutate()}
              >
                <KeyRound className="h-4 w-4" />
                <span>Update Password</span>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title="SQLite Database Backup"
              description="Creates an atomic WAL-safe SQLite snapshot from the persistent disk."
            />
            <CardContent>
              <Button
                variant="outline"
                onClick={() => downloadWithAuth('/api/system/backup', 'outreach-engine-backup.db')}
              >
                <Database className="h-4 w-4" />
                <span>Download SQLite Backup (.db)</span>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader title="Recent Security &amp; System Audit Log" />
        <CardContent className="p-0">
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2">Timestamp</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Entity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {(logsData?.logs || []).map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-2 text-slate-500">{new Date(log.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 font-medium text-slate-800">{log.action}</td>
                    <td className="px-4 py-2 text-slate-600">{log.entityType} {log.entityId ? `(${log.entityId})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

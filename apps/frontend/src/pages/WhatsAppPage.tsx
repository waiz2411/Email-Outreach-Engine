import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare,
  QrCode,
  RefreshCw,
  Send,
  Trash2,
  Unplug,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Modal,
  Skeleton,
  statusTone,
} from '../components/ui';
import type { OutlookAccountDto } from './OutlookAccountsPage';

interface WhatsAppStateDto {
  connectionStatus: string;
  linkedPhoneNumber: string | null;
  recipientPhoneNumber: string | null;
  qrCodeDataUrl: string | null;
  qrExpiresAt: string | null;
  qrExpired: boolean;
  hasStoredSession: boolean;
  lastConnectedAt: string | null;
  lastNotificationAt: string | null;
  lastError: string | null;
  includeBodyPreview: boolean;
  notifyNewEmail: boolean;
  notifyReply: boolean;
  notifyCampaignComplete: boolean;
  notifySendError: boolean;
  notifyWhatsAppError: boolean;
}

interface NotificationJobDto {
  id: string;
  eventType: string;
  recipientPhone: string;
  messageText: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  outlookAccount: { id: string; email: string } | null;
}

export function WhatsAppPage() {
  const queryClient = useQueryClient();
  const [recipientInput, setRecipientInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDeleteModal, setConfirmDeleteModal] = useState(false);

  const { data: waState, isLoading } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => apiRequest<WhatsAppStateDto>('/api/whatsapp/status'),
    refetchInterval: (query) => {
      const status = query.state.data?.connectionStatus;
      return status === 'INITIALIZING' || status === 'QR_READY' || status === 'RECONNECTING' ? 2000 : 8000;
    },
  });

  const { data: notificationsData } = useQuery({
    queryKey: ['whatsapp-notifications'],
    queryFn: () => apiRequest<{ notifications: NotificationJobDto[] }>('/api/whatsapp/notifications'),
    refetchInterval: 8000,
  });

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => apiRequest<{ accounts: OutlookAccountDto[] }>('/api/accounts'),
  });

  useEffect(() => {
    if (waState?.recipientPhoneNumber !== undefined) {
      setRecipientInput(waState.recipientPhoneNumber || '');
    }
  }, [waState?.recipientPhoneNumber]);

  const connectMutation = useMutation({
    mutationFn: () => apiRequest<WhatsAppStateDto>('/api/whatsapp/connect', { method: 'POST' }),
    onSuccess: () => {
      setErrorMessage(null);
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
    },
    onError: (err) => setErrorMessage((err as Error).message),
  });

  const refreshQrMutation = useMutation({
    mutationFn: () => apiRequest<WhatsAppStateDto>('/api/whatsapp/refresh-qr', { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] }),
    onError: (err) => setErrorMessage((err as Error).message),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiRequest<WhatsAppStateDto>('/api/whatsapp/disconnect', { method: 'POST' }),
    onSuccess: () => {
      setStatusMessage('WhatsApp disconnected. Encrypted session data remains saved unless deleted.');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
    },
    onError: (err) => setErrorMessage((err as Error).message),
  });

  const deleteSessionMutation = useMutation({
    mutationFn: () => apiRequest<WhatsAppStateDto>('/api/whatsapp/session', { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDeleteModal(false);
      setStatusMessage('Stored WhatsApp session credentials deleted permanently.');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
    },
    onError: (err) => setErrorMessage((err as Error).message),
  });

  const saveSettingsMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiRequest<WhatsAppStateDto>('/api/whatsapp/settings', { method: 'PATCH', json: payload }),
    onSuccess: () => {
      setErrorMessage(null);
      setStatusMessage('WhatsApp notification preferences saved.');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
    },
    onError: (err) => setErrorMessage((err as Error).message),
  });

  const testMutation = useMutation({
    mutationFn: () => apiRequest<{ jobId: string; status: string }>('/api/whatsapp/test', { method: 'POST' }),
    onSuccess: (res) => {
      setErrorMessage(null);
      setStatusMessage(`Test notification sent (${res.status}).`);
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
    },
    onError: (err) => setErrorMessage((err as Error).message),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean; status: string }>(`/api/whatsapp/notifications/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      setErrorMessage(null);
      setStatusMessage('Notification retry processed.');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-notifications'] });
    },
    onError: (err) => setErrorMessage((err as Error).message),
  });

  const toggleAccountAlerts = useMutation({
    mutationFn: (acc: OutlookAccountDto) =>
      apiRequest(`/api/accounts/${acc.id}`, {
        method: 'PATCH',
        json: {
          dailySendLimit: acc.dailySendLimit,
          minDelayMinutes: acc.minDelayMinutes,
          maxDelayMinutes: acc.maxDelayMinutes,
          scheduleStartTime: acc.scheduleStartTime,
          scheduleEndTime: acc.scheduleEndTime,
          timezone: acc.timezone,
          allowedWeekdays: acc.allowedWeekdays,
          whatsappNotificationsEnabled: !acc.whatsappNotificationsEnabled,
        },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });

  if (isLoading || !waState) {
    return <Skeleton className="h-72" />;
  }

  return (
    <div className="space-y-6">
      <Alert tone="warning" title="Unofficial WhatsApp Web Integration Notice">
        This feature connects to WhatsApp Web via the open-source Baileys multi-device protocol (QR-code linked device). Unofficial WhatsApp automation is not endorsed by WhatsApp/Meta and may experience unexpected disconnections or account restrictions if misused. This engine restricts outbound alerts strictly to your single configured personal recipient number and prohibits bulk WhatsApp messaging.
      </Alert>

      {errorMessage && <Alert tone="danger">{errorMessage}</Alert>}
      {statusMessage && <Alert tone="success">{statusMessage}</Alert>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Card 1: WhatsApp Connection */}
        <Card>
          <CardHeader
            title="WhatsApp Connection"
            description="Link an existing WhatsApp or WhatsApp Business number by scanning a QR code."
            action={
              <Badge tone={statusTone(waState.connectionStatus)}>{waState.connectionStatus}</Badge>
            }
          />
          <CardContent className="space-y-4">
            {waState.lastError && <Alert tone="danger">{waState.lastError}</Alert>}

            <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs">
              <div>
                <p className="text-[11px] text-slate-500">Linked Number</p>
                <p className="font-semibold text-slate-900">{waState.linkedPhoneNumber || 'Not linked'}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Stored Encrypted Session</p>
                <p className="font-semibold text-slate-900">{waState.hasStoredSession ? 'Saved in SQLite' : 'None'}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Last Connected</p>
                <p className="font-medium text-slate-700">
                  {waState.lastConnectedAt ? new Date(waState.lastConnectedAt).toLocaleString() : 'Never'}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Last Successful Alert</p>
                <p className="font-medium text-slate-700">
                  {waState.lastNotificationAt ? new Date(waState.lastNotificationAt).toLocaleString() : 'Never'}
                </p>
              </div>
            </div>

            {/* QR Display */}
            {waState.qrCodeDataUrl && (
              <div className="flex flex-col items-center space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-center">
                <img
                  src={waState.qrCodeDataUrl}
                  alt="WhatsApp Web QR Code"
                  className="h-56 w-56 rounded-lg border border-slate-100"
                />
                <p className="max-w-xs text-xs font-medium text-slate-700">
                  Open WhatsApp on your phone, go to Linked Devices, tap Link a Device, and scan this QR code.
                </p>
              </div>
            )}

            {waState.qrExpired && (
              <Alert tone="warning" title="QR Code Expired">
                The previous QR code timed out before scanning. Generate a fresh QR code to continue.
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              {waState.connectionStatus === 'DISCONNECTED' || waState.connectionStatus === 'LOGGED_OUT' || waState.connectionStatus === 'ERROR' ? (
                <Button
                  variant="secondary"
                  disabled={connectMutation.isPending}
                  onClick={() => connectMutation.mutate()}
                >
                  <QrCode className="h-4 w-4" />
                  <span>{waState.hasStoredSession ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}</span>
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={refreshQrMutation.isPending}
                    onClick={() => refreshQrMutation.mutate()}
                  >
                    <RefreshCw className="h-4 w-4" />
                    <span>Refresh QR Code</span>
                  </Button>
                  <Button
                    variant="outline"
                    disabled={disconnectMutation.isPending}
                    onClick={() => disconnectMutation.mutate()}
                  >
                    <Unplug className="h-4 w-4" />
                    <span>Disconnect WhatsApp</span>
                  </Button>
                </>
              )}

              {waState.hasStoredSession && (
                <Button
                  variant="outline"
                  className="text-rose-600 hover:bg-rose-50"
                  onClick={() => setConfirmDeleteModal(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Delete Stored Session</span>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Card 2: Recipient & Preferences */}
        <Card>
          <CardHeader
            title="Notification Recipient &amp; Alert Rules"
            description="Configure your personal main WhatsApp number and which Outlook events trigger alerts."
          />
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700" htmlFor="recipientPhone">
                Send email alerts to this WhatsApp number
              </label>
              <div className="flex gap-2">
                <Input
                  id="recipientPhone"
                  placeholder="International format e.g. +923001234567"
                  value={recipientInput}
                  onChange={(e) => setRecipientInput(e.target.value)}
                />
                <Button
                  variant="secondary"
                  disabled={saveSettingsMutation.isPending}
                  onClick={() =>
                    saveSettingsMutation.mutate({
                      recipientPhoneNumber: recipientInput.trim() || null,
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </div>

            {waState.connectionStatus === 'CONNECTED' && (
              <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <span className="text-xs font-medium text-emerald-900">
                  Verify delivery from linked device to {waState.recipientPhoneNumber || '(save number first)'}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!waState.recipientPhoneNumber || testMutation.isPending}
                  onClick={() => testMutation.mutate()}
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>{testMutation.isPending ? 'Sending...' : 'Send Test Notification'}</span>
                </Button>
              </div>
            )}

            <div className="space-y-2 border-t border-slate-100 pt-3 text-xs">
              <p className="font-semibold text-slate-800">Trigger Events</p>
              {[
                { key: 'notifyNewEmail', label: 'New incoming emails' },
                { key: 'notifyReply', label: 'Outreach campaign replies' },
                { key: 'notifyCampaignComplete', label: 'Campaign completion' },
                { key: 'notifySendError', label: 'Email sending errors' },
                { key: 'notifyWhatsAppError', label: 'WhatsApp connection warnings' },
                { key: 'includeBodyPreview', label: 'Include short email body snippet (optional; off by default)' },
              ].map((item) => (
                <label key={item.key} className="flex items-center gap-2 text-slate-700">
                  <input
                    type="checkbox"
                    checked={Boolean(waState[item.key as keyof WhatsAppStateDto])}
                    onChange={(e) =>
                      saveSettingsMutation.mutate({ [item.key]: e.target.checked })
                    }
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>

            <div className="space-y-2 border-t border-slate-100 pt-3 text-xs">
              <p className="font-semibold text-slate-800">Enabled Outlook Accounts</p>
              {(accountsData?.accounts || []).length === 0 ? (
                <p className="text-slate-500">Connect an Outlook account to toggle per-account alerts.</p>
              ) : (
                (accountsData?.accounts || []).map((acc) => (
                  <label key={acc.id} className="flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      checked={acc.whatsappNotificationsEnabled}
                      onChange={() => toggleAccountAlerts.mutate(acc)}
                    />
                    <span>{acc.email}</span>
                  </label>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Persistent Notification Queue */}
      <Card>
        <CardHeader
          title="WhatsApp Notification Queue &amp; Delivery History"
          description="Notifications queued while WhatsApp is disconnected stay preserved in SQLite and can be retried safely."
        />
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Recipient</th>
                  <th className="px-4 py-2.5">Message</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Attempts</th>
                  <th className="px-4 py-2.5">Created</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {(notificationsData?.notifications || []).length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      <MessageSquare className="mx-auto mb-2 h-5 w-5 text-slate-400" />
                      No WhatsApp notifications queued yet.
                    </td>
                  </tr>
                ) : (
                  (notificationsData?.notifications || []).map((n) => (
                    <tr key={n.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-800">{n.eventType}</td>
                      <td className="px-4 py-2.5 text-slate-600">{n.recipientPhone}</td>
                      <td className="max-w-md px-4 py-2.5">
                        <pre className="whitespace-pre-wrap font-sans text-[11px] text-slate-700">{n.messageText}</pre>
                        {n.lastError && <p className="mt-1 text-[11px] text-rose-600">{n.lastError}</p>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={statusTone(n.status)}>{n.status}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{n.attempts} / {n.maxAttempts}</td>
                      <td className="px-4 py-2.5 text-slate-500">{new Date(n.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right">
                        {['FAILED', 'PENDING', 'RETRYING'].includes(n.status) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryMutation.isPending || waState.connectionStatus !== 'CONNECTED'}
                            onClick={() => retryMutation.mutate(n.id)}
                          >
                            Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Modal
        open={confirmDeleteModal}
        onClose={() => setConfirmDeleteModal(false)}
        title="Delete Stored WhatsApp Session?"
        description="This deletes the encrypted session keys from the persistent database and logs out the linked device. You will need to scan a new QR code to reconnect."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmDeleteModal(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={deleteSessionMutation.isPending}
            onClick={() => deleteSessionMutation.mutate()}
          >
            Delete Session
          </Button>
        </div>
      </Modal>
    </div>
  );
}

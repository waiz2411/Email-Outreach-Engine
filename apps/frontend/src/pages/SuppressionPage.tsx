import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldBan, Trash2 } from 'lucide-react';
import { apiRequest } from '../lib/api';
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

interface SuppressionEntryDto {
  id: string;
  email: string;
  reason: string;
  notes: string | null;
  createdAt: string;
}

export function SuppressionPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('MANUAL');
  const [notes, setNotes] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['suppression'],
    queryFn: () => apiRequest<{ entries: SuppressionEntryDto[] }>('/api/suppression'),
  });

  const addMutation = useMutation({
    mutationFn: () =>
      apiRequest('/api/suppression', {
        method: 'POST',
        json: { email, reason, notes: notes || undefined },
      }),
    onSuccess: () => {
      setEmail('');
      setNotes('');
      setErrorMsg(null);
      void queryClient.invalidateQueries({ queryKey: ['suppression'] });
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/suppression/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['suppression'] }),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Add Suppressed Recipient"
          description="Addresses on this list (hard bounces, unsubscribes, or manual blocks) are never emailed by any campaign."
        />
        <CardContent className="space-y-3">
          {errorMsg && <Alert tone="danger">{errorMsg}</Alert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Input
              type="email"
              placeholder="recipient@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="MANUAL">Manual Block</option>
              <option value="UNSUBSCRIBED">Unsubscribed</option>
              <option value="HARD_BOUNCE">Hard Bounce</option>
              <option value="COMPLAINT">Complaint</option>
            </Select>
            <Input
              placeholder="Optional notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <Button variant="secondary" disabled={!email || addMutation.isPending} onClick={() => addMutation.mutate()}>
              <Plus className="h-4 w-4" />
              <span>Add to Suppression List</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title={`Suppressed Addresses (${data?.entries.length ?? 0})`} />
        <CardContent className="p-0">
          {isLoading ? (
            <p className="p-4 text-xs text-slate-500">Loading suppression list...</p>
          ) : !data || data.entries.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ShieldBan}
                title="Suppression list is empty"
                description="Permanent hard bounces and unsubscribes will appear here automatically."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5">Email</th>
                    <th className="px-4 py-2.5">Reason</th>
                    <th className="px-4 py-2.5">Notes</th>
                    <th className="px-4 py-2.5">Added</th>
                    <th className="px-4 py-2.5 text-right">Remove</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {data.entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-900">{entry.email}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={statusTone(entry.reason === 'MANUAL' ? 'PAUSED' : 'BOUNCED')}>
                          {entry.reason}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{entry.notes || '—'}</td>
                      <td className="px-4 py-2.5 text-slate-500">{new Date(entry.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-rose-600"
                          onClick={() => deleteMutation.mutate(entry.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

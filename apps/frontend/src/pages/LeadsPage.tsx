import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Download, Edit3, Upload, Users } from 'lucide-react';
import { apiRequest, downloadWithAuth, getCsrfToken } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  Input,
  Modal,
  Select,
  Textarea,
  statusTone,
} from '../components/ui';
import type { OutlookAccountDto } from './OutlookAccountsPage';

interface LeadDto {
  id: string;
  outlookAccountId: string;
  campaignId: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  subject: string;
  body: string;
  status: string;
  deliveryStatus: string;
  bounceType: string;
  openCount: number;
  clickCount: number;
  replied: boolean;
  errorMessage: string | null;
  lastSentAt: string | null;
  outlookAccount: { id: string; email: string };
  campaign: { id: string; name: string } | null;
}

interface ImportPreviewResponse {
  batchId: string;
  outlookAccountId: string;
  filename: string;
  fileType: 'CSV' | 'XLSX';
  totalRows: number;
  missingMandatoryColumns: string[];
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  validRows: Array<{
    rowNumber: number;
    email: string;
    firstName: string | null;
    company: string | null;
    subject: string;
  }>;
  invalidRows: Array<{
    rowNumber: number;
    email: string;
    subject: string;
    errors: string[];
  }>;
  duplicateRows: Array<{
    rowNumber: number;
    email: string;
    reason: string;
  }>;
}

export function LeadsPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const [filterAccountId, setFilterAccountId] = useState(searchParams.get('accountId') || '');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [importAccountId, setImportAccountId] = useState(searchParams.get('accountId') || '');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<ImportPreviewResponse | null>(null);
  const [dupResolution, setDupResolution] = useState<'SKIP' | 'UPDATE'>('SKIP');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [bulkCampaignId, setBulkCampaignId] = useState('');
  const [editingLead, setEditingLead] = useState<LeadDto | null>(null);
  const [leadForm, setLeadForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
    company: '',
    subject: '',
    body: '',
  });

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => apiRequest<{ accounts: OutlookAccountDto[] }>('/api/accounts'),
  });

  const { data: campaignsData } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => apiRequest<{ campaigns: Array<{ id: string; name: string; outlookAccountId: string }> }>('/api/campaigns'),
  });

  const { data: leadsData, isLoading } = useQuery({
    queryKey: ['leads', filterAccountId, filterStatus, search, page],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (filterAccountId) qs.set('outlookAccountId', filterAccountId);
      if (filterStatus) qs.set('status', filterStatus);
      if (search) qs.set('search', search);
      qs.set('page', String(page));
      return apiRequest<{
        leads: LeadDto[];
        pagination: { page: number; totalPages: number; total: number };
      }>(`/api/leads?${qs.toString()}`);
    },
  });

  const uploadPreviewMutation = useMutation({
    mutationFn: async () => {
      if (!importAccountId) throw new Error('Select an Outlook account first');
      if (!selectedFile) throw new Error('Choose a CSV or XLSX file to upload');
      const formData = new FormData();
      formData.append('outlookAccountId', importAccountId);
      formData.append('file', selectedFile);

      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;

      const res = await fetch('/api/leads/import/preview', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Preview failed');
      return json as ImportPreviewResponse;
    },
    onSuccess: (res) => {
      setImportError(null);
      setImportSuccess(null);
      setPreviewData(res);
    },
    onError: (err) => setImportError((err as Error).message),
  });

  const confirmImportMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ importedCount: number; updatedDuplicates: number; skippedDuplicates: number; invalidCount: number }>(
        '/api/leads/import/confirm',
        {
          method: 'POST',
          json: {
            batchId: previewData!.batchId,
            duplicateResolution: dupResolution,
          },
        },
      ),
    onSuccess: (res) => {
      setPreviewData(null);
      setSelectedFile(null);
      setImportSuccess(
        `Import complete: ${res.importedCount} leads added, ${res.updatedDuplicates} duplicates updated, ${res.skippedDuplicates} duplicates skipped, ${res.invalidCount} invalid rows excluded.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => setImportError((err as Error).message),
  });

  const editLeadMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/leads/${editingLead!.id}`, {
        method: 'PATCH',
        json: leadForm,
      }),
    onSuccess: () => {
      setEditingLead(null);
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (err) => setImportError((err as Error).message),
  });

  const bulkMutation = useMutation({
    mutationFn: (action: 'ASSIGN_CAMPAIGN' | 'SUPPRESS' | 'DELETE') =>
      apiRequest('/api/leads/bulk', {
        method: 'POST',
        json: {
          leadIds: selectedLeadIds,
          action,
          campaignId: action === 'ASSIGN_CAMPAIGN' ? bulkCampaignId : undefined,
        },
      }),
    onSuccess: () => {
      setSelectedLeadIds([]);
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (err) => setImportError((err as Error).message),
  });

  const accounts = accountsData?.accounts || [];
  const leads = leadsData?.leads || [];

  const toggleSelectAll = () => {
    if (selectedLeadIds.length === leads.length) {
      setSelectedLeadIds([]);
    } else {
      setSelectedLeadIds(leads.map((l) => l.id));
    }
  };

  return (
    <div className="space-y-6">
      {/* Template & Import Wizard */}
      <Card>
        <CardHeader
          title="Import Leads (Per Outlook Account)"
          description="Select an Outlook account, download the template, upload CSV/XLSX, validate every row, resolve duplicates, and confirm."
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadWithAuth('/api/leads/template?format=csv', 'outreach-lead-template.csv')}
              >
                <Download className="h-3.5 w-3.5" />
                <span>Download Lead Upload Template</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadWithAuth('/api/leads/template?format=xlsx', 'outreach-lead-template.xlsx')}
              >
                <Download className="h-3.5 w-3.5" />
                <span>XLSX Template</span>
              </Button>
            </div>
          }
        />
        <CardContent className="space-y-4">
          {importError && <Alert tone="danger">{importError}</Alert>}
          {importSuccess && <Alert tone="success">{importSuccess}</Alert>}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Target Outlook Account</label>
              <Select value={importAccountId} onChange={(e) => setImportAccountId(e.target.value)}>
                <option value="">Select an Outlook account...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email} ({a.connectionStatus})
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Completed CSV or XLSX File</label>
              <input
                type="file"
                accept=".csv,.xlsx"
                aria-label="Upload lead file"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
              />
            </div>

            <div className="flex items-end">
              <Button
                variant="secondary"
                disabled={uploadPreviewMutation.isPending}
                onClick={() => uploadPreviewMutation.mutate()}
              >
                <Upload className="h-4 w-4" />
                <span>{uploadPreviewMutation.isPending ? 'Validating...' : 'Upload & Preview Leads'}</span>
              </Button>
            </div>
          </div>

          {/* Preview Results */}
          {previewData && (
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge tone="neutral">Total: {previewData.totalRows}</Badge>
                  <Badge tone="success">Valid: {previewData.validCount}</Badge>
                  <Badge tone="danger">Invalid: {previewData.invalidCount}</Badge>
                  <Badge tone="warning">Duplicates: {previewData.duplicateCount}</Badge>
                </div>
                {previewData.invalidCount > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadWithAuth(
                        `/api/leads/import/${previewData.batchId}/invalid-report`,
                        `invalid-rows-${previewData.batchId}.csv`,
                      )
                    }
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download Invalid Rows Report</span>
                  </Button>
                )}
              </div>

              {previewData.missingMandatoryColumns.length > 0 && (
                <Alert tone="danger">
                  Missing mandatory column(s): {previewData.missingMandatoryColumns.join(', ')}
                </Alert>
              )}

              {previewData.invalidRows.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-rose-700">Invalid Rows (will NOT be imported)</p>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-rose-200 bg-white">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-rose-50 text-rose-800">
                        <tr>
                          <th className="px-3 py-1.5">Row</th>
                          <th className="px-3 py-1.5">Email</th>
                          <th className="px-3 py-1.5">Validation Errors</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {previewData.invalidRows.map((r) => (
                          <tr key={r.rowNumber}>
                            <td className="px-3 py-1.5">{r.rowNumber}</td>
                            <td className="px-3 py-1.5">{r.email || '(empty)'}</td>
                            <td className="px-3 py-1.5 text-rose-700">{r.errors.join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {previewData.duplicateRows.length > 0 && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-amber-800">Duplicate Email Addresses Detected</p>
                    <div className="flex items-center gap-2 text-xs">
                      <span>Resolution:</span>
                      <Select
                        className="h-8 w-56"
                        value={dupResolution}
                        onChange={(e) => setDupResolution(e.target.value as 'SKIP' | 'UPDATE')}
                      >
                        <option value="SKIP">Skip all duplicates</option>
                        <option value="UPDATE">Update existing leads with new data</option>
                      </Select>
                    </div>
                  </div>
                </div>
              )}

              {previewData.validRows.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-emerald-700">Validated Rows Preview</p>
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-3 py-1.5">Row</th>
                          <th className="px-3 py-1.5">Email</th>
                          <th className="px-3 py-1.5">Name</th>
                          <th className="px-3 py-1.5">Company</th>
                          <th className="px-3 py-1.5">Subject</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {previewData.validRows.slice(0, 20).map((r) => (
                          <tr key={r.rowNumber}>
                            <td className="px-3 py-1.5">{r.rowNumber}</td>
                            <td className="px-3 py-1.5 font-medium">{r.email}</td>
                            <td className="px-3 py-1.5">{r.firstName || '-'}</td>
                            <td className="px-3 py-1.5">{r.company || '-'}</td>
                            <td className="px-3 py-1.5">{r.subject}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPreviewData(null)}>Discard Preview</Button>
                <Button
                  variant="secondary"
                  disabled={
                    confirmImportMutation.isPending ||
                    (previewData.validCount === 0 && (previewData.duplicateCount === 0 || dupResolution === 'SKIP'))
                  }
                  onClick={() => confirmImportMutation.mutate()}
                >
                  {confirmImportMutation.isPending ? 'Importing...' : 'Confirm & Save Valid Leads'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Leads List */}
      <Card>
        <CardHeader
          title={`Leads Directory (${leadsData?.pagination.total ?? 0})`}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const qs = new URLSearchParams();
                if (filterAccountId) qs.set('outlookAccountId', filterAccountId);
                if (filterStatus) qs.set('status', filterStatus);
                downloadWithAuth(`/api/leads/export?${qs.toString()}`, 'leads-export.csv');
              }}
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Leads CSV</span>
            </Button>
          }
        />
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              placeholder="Search email, name, company, subject..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
            <Select
              value={filterAccountId}
              onChange={(e) => {
                setFilterAccountId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Outlook Accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.email}</option>
              ))}
            </Select>
            <Select
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Statuses</option>
              {['VALIDATED', 'SCHEDULED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED', 'REPLIED', 'UNSUBSCRIBED', 'SUPPRESSED'].map(
                (st) => (
                  <option key={st} value={st}>{st}</option>
                ),
              )}
            </Select>
          </div>

          {selectedLeadIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs">
              <span className="font-medium text-indigo-900">{selectedLeadIds.length} selected</span>
              <Select
                className="h-8 w-52"
                value={bulkCampaignId}
                onChange={(e) => setBulkCampaignId(e.target.value)}
              >
                <option value="">Assign to campaign...</option>
                {(campaignsData?.campaigns || []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="secondary"
                disabled={!bulkCampaignId}
                onClick={() => bulkMutation.mutate('ASSIGN_CAMPAIGN')}
              >
                Assign
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulkMutation.mutate('SUPPRESS')}>
                Suppress
              </Button>
              <Button size="sm" variant="danger" onClick={() => bulkMutation.mutate('DELETE')}>
                Delete
              </Button>
            </div>
          )}

          {isLoading ? (
            <p className="text-xs text-slate-500">Loading leads...</p>
          ) : leads.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No leads found"
              description="Upload a CSV or XLSX lead file above, or adjust your search filters."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selectedLeadIds.length === leads.length && leads.length > 0}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th className="px-3 py-2.5">Recipient</th>
                    <th className="px-3 py-2.5">Outlook Account</th>
                    <th className="px-3 py-2.5">Subject</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Engagement</th>
                    <th className="px-3 py-2.5 text-right">Edit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {leads.map((lead) => (
                    <tr key={lead.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedLeadIds.includes(lead.id)}
                          onChange={(e) =>
                            setSelectedLeadIds((prev) =>
                              e.target.checked ? [...prev, lead.id] : prev.filter((x) => x !== lead.id),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{lead.email}</p>
                        <p className="text-[11px] text-slate-500">
                          {[lead.firstName, lead.lastName, lead.company].filter(Boolean).join(' • ') || '—'}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{lead.outlookAccount.email}</td>
                      <td className="max-w-xs truncate px-3 py-2.5 text-slate-800">{lead.subject}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={statusTone(lead.status)}>{lead.status}</Badge>
                        {lead.errorMessage && (
                          <p className="mt-1 max-w-xs truncate text-[11px] text-rose-600">{lead.errorMessage}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">
                        O:{lead.openCount} C:{lead.clickCount} {lead.replied ? '• Replied' : ''}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingLead(lead);
                            setLeadForm({
                              email: lead.email,
                              firstName: lead.firstName || '',
                              lastName: lead.lastName || '',
                              company: lead.company || '',
                              subject: lead.subject,
                              body: lead.body,
                            });
                          }}
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {leadsData && leadsData.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>
                Page {leadsData.pagination.page} of {leadsData.pagination.totalPages}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= leadsData.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal
        open={Boolean(editingLead)}
        onClose={() => setEditingLead(null)}
        title={`Edit Lead (${editingLead?.email || ''})`}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium">Email</label>
              <Input value={leadForm.email} onChange={(e) => setLeadForm((s) => ({ ...s, email: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Company</label>
              <Input value={leadForm.company} onChange={(e) => setLeadForm((s) => ({ ...s, company: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">First Name</label>
              <Input value={leadForm.firstName} onChange={(e) => setLeadForm((s) => ({ ...s, firstName: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Last Name</label>
              <Input value={leadForm.lastName} onChange={(e) => setLeadForm((s) => ({ ...s, lastName: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Personalized Subject</label>
            <Input value={leadForm.subject} onChange={(e) => setLeadForm((s) => ({ ...s, subject: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Personalized Body</label>
            <Textarea rows={5} value={leadForm.body} onChange={(e) => setLeadForm((s) => ({ ...s, body: e.target.value }))} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditingLead(null)}>Cancel</Button>
            <Button variant="secondary" onClick={() => editLeadMutation.mutate()}>Save Lead</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

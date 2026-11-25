import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  emailSchema,
  extractTemplateVariables,
  looksLikeHtml,
  normalizeEmail,
  renderPersonalizedEmail,
} from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import { sanitizeEmailHtml } from '../utils/sanitizer.js';
import {
  type InvalidLeadRow,
  type ParsedLeadRow,
  generateGenericCsvExport,
  generateInvalidRowsCsv,
  generateLeadTemplateCsv,
  generateLeadTemplateXlsx,
  previewLeadImport,
} from '../services/leads/leadFileService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

interface StoredBatchReport {
  validRows: ParsedLeadRow[];
  invalidRows: InvalidLeadRow[];
  duplicateRows: Array<{
    rowNumber: number;
    email: string;
    reason: string;
    existingLeadId?: string;
    parsed: ParsedLeadRow;
  }>;
}

export function createLeadRoutes(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/template', async (req, res, next) => {
    try {
      const format = String(req.query.format || 'csv').toLowerCase();
      if (format === 'xlsx') {
        const buffer = await generateLeadTemplateXlsx();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="outreach-lead-template.xlsx"');
        res.send(buffer);
        return;
      }

      const buffer = generateLeadTemplateCsv();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="outreach-lead-template.csv"');
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  router.post('/import/preview', upload.single('file'), async (req, res, next) => {
    try {
      const outlookAccountId = String(req.body?.outlookAccountId || '').trim();
      if (!outlookAccountId) {
        res.status(400).json({ error: 'Select an Outlook account before uploading leads' });
        return;
      }

      const account = await prisma.outlookAccount.findUnique({ where: { id: outlookAccountId } });
      if (!account) {
        res.status(404).json({ error: 'Selected Outlook account not found' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'Upload a CSV or XLSX file' });
        return;
      }

      const existingLeads = await prisma.lead.findMany({
        where: { outlookAccountId },
        select: { id: true, email: true },
      });
      const existingMap = new Map(existingLeads.map((l) => [normalizeEmail(l.email), l.id]));

      const preview = await previewLeadImport({
        buffer: req.file.buffer,
        filename: req.file.originalname,
        existingAccountEmails: existingMap,
      });

      const reportPayload: StoredBatchReport = {
        validRows: preview.validRows,
        invalidRows: preview.invalidRows,
        duplicateRows: preview.duplicateRows,
      };

      const batch = await prisma.leadImportBatch.create({
        data: {
          outlookAccountId,
          filename: req.file.originalname.slice(0, 200),
          fileType: preview.fileType,
          totalRows: preview.totalRows,
          validRows: preview.validRows.length,
          invalidRows: preview.invalidRows.length,
          duplicateRows: preview.duplicateRows.length,
          invalidRowsReportJson: JSON.stringify(reportPayload),
        },
      });

      res.json({
        batchId: batch.id,
        outlookAccountId,
        filename: batch.filename,
        fileType: preview.fileType,
        totalRows: preview.totalRows,
        detectedColumns: preview.detectedColumns,
        missingMandatoryColumns: preview.missingMandatoryColumns,
        validCount: preview.validRows.length,
        invalidCount: preview.invalidRows.length,
        duplicateCount: preview.duplicateRows.length,
        validRows: preview.validRows.slice(0, 250),
        invalidRows: preview.invalidRows.slice(0, 250),
        duplicateRows: preview.duplicateRows.slice(0, 250),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/import/:batchId/invalid-report', async (req, res, next) => {
    try {
      const batch = await prisma.leadImportBatch.findUnique({ where: { id: req.params.batchId } });
      if (!batch || !batch.invalidRowsReportJson) {
        res.status(404).json({ error: 'Import batch report not found' });
        return;
      }
      const parsed = JSON.parse(batch.invalidRowsReportJson) as StoredBatchReport;
      const csvBuffer = generateInvalidRowsCsv(parsed.invalidRows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="invalid-rows-${batch.id}.csv"`);
      res.send(csvBuffer);
    } catch (err) {
      next(err);
    }
  });

  router.post('/import/confirm', async (req, res, next) => {
    try {
      const schema = z.object({
        batchId: z.string().min(1),
        duplicateResolution: z.enum(['SKIP', 'UPDATE']).default('SKIP'),
        campaignId: z.string().optional().nullable(),
      });
      const parsedBody = schema.safeParse(req.body);
      if (!parsedBody.success) {
        res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'Invalid confirm payload' });
        return;
      }

      const batch = await prisma.leadImportBatch.findUnique({ where: { id: parsedBody.data.batchId } });
      if (!batch || !batch.invalidRowsReportJson) {
        res.status(404).json({ error: 'Import batch not found' });
        return;
      }
      if (batch.importedCount > 0) {
        res.status(409).json({ error: 'This import batch has already been confirmed.' });
        return;
      }

      if (parsedBody.data.campaignId) {
        const campaign = await prisma.campaign.findUnique({ where: { id: parsedBody.data.campaignId } });
        if (!campaign || campaign.outlookAccountId !== batch.outlookAccountId) {
          res.status(400).json({ error: 'Selected campaign does not belong to the chosen Outlook account' });
          return;
        }
      }

      const report = JSON.parse(batch.invalidRowsReportJson) as StoredBatchReport;
      const suppressionList = await prisma.suppressionEntry.findMany({ select: { email: true } });
      const suppressedSet = new Set(suppressionList.map((s) => normalizeEmail(s.email)));

      let importedCount = 0;
      let updatedDuplicates = 0;
      let skippedDuplicates = 0;

      await prisma.$transaction(async (tx) => {
        for (const row of report.validRows) {
          const isSuppressed = suppressedSet.has(row.email);
          await tx.lead.create({
            data: {
              outlookAccountId: batch.outlookAccountId,
              campaignId: parsedBody.data.campaignId ?? null,
              importBatchId: batch.id,
              email: row.email,
              firstName: row.firstName,
              lastName: row.lastName,
              company: row.company,
              website: row.website,
              phone: row.phone,
              campaignNameHint: row.campaignNameHint,
              subject: row.subject,
              body: row.body,
              isHtmlBody: row.isHtmlBody,
              customFieldsJson: JSON.stringify(row.customFields),
              status: isSuppressed ? 'SUPPRESSED' : 'VALIDATED',
            },
          });
          importedCount++;
        }

        for (const dup of report.duplicateRows) {
          if (parsedBody.data.duplicateResolution === 'UPDATE' && dup.existingLeadId) {
            await tx.lead.update({
              where: { id: dup.existingLeadId },
              data: {
                firstName: dup.parsed.firstName,
                lastName: dup.parsed.lastName,
                company: dup.parsed.company,
                website: dup.parsed.website,
                phone: dup.parsed.phone,
                subject: dup.parsed.subject,
                body: dup.parsed.body,
                isHtmlBody: dup.parsed.isHtmlBody,
                customFieldsJson: JSON.stringify(dup.parsed.customFields),
                importBatchId: batch.id,
              },
            });
            updatedDuplicates++;
          } else {
            skippedDuplicates++;
          }
        }

        await tx.leadImportBatch.update({
          where: { id: batch.id },
          data: {
            importedCount: importedCount + updatedDuplicates,
            duplicateResolution: parsedBody.data.duplicateResolution,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'LEADS_IMPORTED',
            entityType: 'LeadImportBatch',
            entityId: batch.id,
            detailsJson: JSON.stringify({
              outlookAccountId: batch.outlookAccountId,
              importedCount,
              updatedDuplicates,
              skippedDuplicates,
              invalidRowsSkipped: report.invalidRows.length,
            }),
            ipAddress: req.ip,
          },
        });
      });

      res.json({
        ok: true,
        importedCount,
        updatedDuplicates,
        skippedDuplicates,
        invalidCount: report.invalidRows.length,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const accountId = typeof req.query.outlookAccountId === 'string' ? req.query.outlookAccountId : undefined;
      const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
      const sortBy = String(req.query.sortBy || 'createdAt');
      const sortDir = String(req.query.sortDir || 'desc') === 'asc' ? 'asc' : 'desc';
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 25)));

      const where: Record<string, unknown> = {};
      if (accountId) where.outlookAccountId = accountId;
      if (campaignId) where.campaignId = campaignId;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { email: { contains: search } },
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { company: { contains: search } },
          { subject: { contains: search } },
        ];
      }

      const allowedSorts = new Set(['createdAt', 'email', 'company', 'status', 'lastSentAt']);
      const orderField = allowedSorts.has(sortBy) ? sortBy : 'createdAt';

      const [total, leads] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.findMany({
          where,
          include: {
            outlookAccount: { select: { id: true, email: true } },
            campaign: { select: { id: true, name: true } },
          },
          orderBy: { [orderField]: sortDir },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);

      res.json({
        leads,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/export', async (req, res, next) => {
    try {
      const accountId = typeof req.query.outlookAccountId === 'string' ? req.query.outlookAccountId : undefined;
      const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;

      const where: Record<string, unknown> = {};
      if (accountId) where.outlookAccountId = accountId;
      if (campaignId) where.campaignId = campaignId;
      if (status) where.status = status;

      const leads = await prisma.lead.findMany({
        where,
        include: {
          outlookAccount: { select: { email: true } },
          campaign: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const csv = generateGenericCsvExport(
        leads.map((l) => ({
          id: l.id,
          outlook_account: l.outlookAccount.email,
          campaign: l.campaign?.name ?? '',
          email: l.email,
          first_name: l.firstName ?? '',
          last_name: l.lastName ?? '',
          company: l.company ?? '',
          subject: l.subject,
          status: l.status,
          delivery_status: l.deliveryStatus,
          bounce_type: l.bounceType,
          open_count: l.openCount,
          click_count: l.clickCount,
          replied: l.replied,
          unsubscribed: l.unsubscribed,
          last_sent_at: l.lastSentAt?.toISOString() ?? '',
          last_reply_at: l.lastReplyAt?.toISOString() ?? '',
          error_message: l.errorMessage ?? '',
        })),
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="leads-export.csv"');
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const existing = await prisma.lead.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }

      const schema = z.object({
        email: emailSchema.optional(),
        firstName: z.string().max(120).nullable().optional(),
        lastName: z.string().max(120).nullable().optional(),
        company: z.string().max(200).nullable().optional(),
        website: z.string().max(300).nullable().optional(),
        phone: z.string().max(50).nullable().optional(),
        subject: z.string().trim().min(1).max(300).optional(),
        body: z.string().trim().min(1).max(50000).optional(),
        customFields: z.record(z.string()).optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid lead update' });
        return;
      }

      const nextSubject = parsed.data.subject ?? existing.subject;
      const rawBody = parsed.data.body ?? existing.body;
      const isHtmlBody = looksLikeHtml(rawBody);
      const nextBody = isHtmlBody ? sanitizeEmailHtml(rawBody) : rawBody;
      const nextEmail = parsed.data.email ?? existing.email;
      const nextFirstName = parsed.data.firstName !== undefined ? parsed.data.firstName : existing.firstName;
      const nextLastName = parsed.data.lastName !== undefined ? parsed.data.lastName : existing.lastName;
      const nextCompany = parsed.data.company !== undefined ? parsed.data.company : existing.company;
      const nextWebsite = parsed.data.website !== undefined ? parsed.data.website : existing.website;
      const nextPhone = parsed.data.phone !== undefined ? parsed.data.phone : existing.phone;
      const nextCustomFields = parsed.data.customFields
        ? parsed.data.customFields
        : (JSON.parse(existing.customFieldsJson || '{}') as Record<string, string>);

      // Validate personalization variables
      const vars = [...extractTemplateVariables(nextSubject), ...extractTemplateVariables(nextBody)];
      let nextStatus = existing.status;
      let errorMessage: string | null = existing.errorMessage;
      if (vars.length > 0) {
        const check = renderPersonalizedEmail(nextSubject, nextBody, {
          email: nextEmail,
          first_name: nextFirstName,
          last_name: nextLastName,
          company: nextCompany,
          website: nextWebsite,
          phone: nextPhone,
          ...nextCustomFields,
        });
        if (!check.isValid) {
          res.status(400).json({
            error: `Missing personalization variable(s): ${check.missingVariables.join(', ')}`,
          });
          return;
        }
        if (existing.status === 'FAILED') {
          nextStatus = 'VALIDATED';
          errorMessage = null;
        }
      }

      const updated = await prisma.lead.update({
        where: { id: existing.id },
        data: {
          email: nextEmail,
          firstName: nextFirstName,
          lastName: nextLastName,
          company: nextCompany,
          website: nextWebsite,
          phone: nextPhone,
          subject: nextSubject,
          body: nextBody,
          isHtmlBody,
          customFieldsJson: JSON.stringify(nextCustomFields),
          status: nextStatus,
          errorMessage,
        },
      });

      res.json({ lead: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/bulk', async (req, res, next) => {
    try {
      const schema = z.object({
        leadIds: z.array(z.string().min(1)).min(1),
        action: z.enum(['ASSIGN_CAMPAIGN', 'SUPPRESS', 'DELETE']),
        campaignId: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid bulk request' });
        return;
      }

      const leads = await prisma.lead.findMany({ where: { id: { in: parsed.data.leadIds } } });
      if (leads.length === 0) {
        res.status(404).json({ error: 'No matching leads found' });
        return;
      }

      if (parsed.data.action === 'ASSIGN_CAMPAIGN') {
        if (!parsed.data.campaignId) {
          res.status(400).json({ error: 'Select a target campaign' });
          return;
        }
        const campaign = await prisma.campaign.findUnique({ where: { id: parsed.data.campaignId } });
        if (!campaign) {
          res.status(404).json({ error: 'Campaign not found' });
          return;
        }
        const crossAccount = leads.some((l) => l.outlookAccountId !== campaign.outlookAccountId);
        if (crossAccount) {
          res.status(400).json({
            error: 'Leads assigned to one Outlook account cannot be assigned to another account’s campaign.',
          });
          return;
        }
        await prisma.lead.updateMany({
          where: { id: { in: parsed.data.leadIds } },
          data: { campaignId: campaign.id },
        });
        res.json({ ok: true, count: leads.length });
        return;
      }

      if (parsed.data.action === 'SUPPRESS') {
        await prisma.$transaction(async (tx) => {
          for (const lead of leads) {
            await tx.suppressionEntry.upsert({
              where: { email: normalizeEmail(lead.email) },
              create: {
                email: normalizeEmail(lead.email),
                reason: 'MANUAL',
                sourceAccountId: lead.outlookAccountId,
                sourceLeadId: lead.id,
              },
              update: {},
            });
          }
          await tx.lead.updateMany({
            where: { id: { in: parsed.data.leadIds } },
            data: { status: 'SUPPRESSED' },
          });
          await tx.sendingJob.updateMany({
            where: { leadId: { in: parsed.data.leadIds }, status: 'PENDING' },
            data: { status: 'CANCELLED', lastError: 'Bulk suppressed by admin' },
          });
        });
        res.json({ ok: true, count: leads.length });
        return;
      }

      await prisma.lead.deleteMany({ where: { id: { in: parsed.data.leadIds } } });
      res.json({ ok: true, count: leads.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

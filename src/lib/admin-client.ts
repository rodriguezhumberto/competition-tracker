import { reportImagePreview } from './report-image-client.ts';
import type AlpineType from 'alpinejs';
import {
  newMetric,
  validateMetrics,
  validateProfile,
  modeDescriptions,
  type Metric,
  type ReportProfile,
} from './metrics.ts';
import { zonedClock, resolveReportTime } from './report-time.ts';
import { powerHourTimingWarning } from './power-hour-time.ts';
import { centralReportTime } from './central-time.ts';
import type { ReportInput } from './competition-store.ts';
import { validateItems, type TrackedItem } from './tracked-items.ts';
interface Configuration {
  multiple_items?: boolean;
  item_label?: string;
  items?: TrackedItem[];
  lockedMetricKeys?: string[];
  hasReports?: boolean;
  usedItemCodes?: string[];
  id: number;
  name: string;
  schema_version: number;
  timezone: string;
  metrics: Metric[];
  profile: ReportProfile;
  official_metric_key: string;
  start_date: string;
  end_date: string;
}
async function post(url: string, payload: unknown) {
  const body = new FormData();
  body.set('payload', JSON.stringify(payload));
  const response = await fetch(url, { method: 'POST', body }),
    result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to save.');
  return result;
}
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Unable to complete this request.';
function blankReport(timezone: string): ReportInput {
  const generated_at = zonedClock(timezone);
  return {
    generated_at,
    period_start: generated_at.slice(0, 10),
    period_end: generated_at.slice(0, 10),
    rows: [{ participant_id: '', values: {} }],
  };
}
export function registerCompetitionAdmin(Alpine: typeof AlpineType) {
  Alpine.data(
    'competitionEditor',
    (
      initial: Configuration | null,
      templates: Configuration[],
      today: string,
      activate: boolean,
      options: { saveUrl?: string; successBase?: string; allowSample?: boolean } = {},
    ) => ({
      ...reportImagePreview(),
      step: initial ? 2 : 1,
      editing: !!initial,
      itemModeLocked: initial?.hasReports || false,
      isItemUsed(code: string) {
        return initial?.usedItemCodes?.includes(code) || false;
      },
      busy: false,
      error: '',
      notice: '',
      template: '',
      name: initial?.name || '',
      start_date: initial?.start_date || today,
      end_date: initial?.end_date || today,
      timezone: initial?.timezone || 'America/Chicago',
      is_active: activate,
      multiple_items: initial?.multiple_items || false,
      item_label: initial?.item_label || 'Item',
      items: structuredClone(initial?.items || []) as TrackedItem[],
      addItem() {
        if (this.items.length < 100) this.items.push({ code: '', name: '' });
      },
      validateItems() {
        if (!this.multiple_items) return;
        if (this.item_label.length > 80)
          throw new Error('Enter an item label of up to 80 characters.');
        validateItems(this.items);
      },
      metrics: structuredClone(initial?.metrics || [newMetric()]) as Metric[],
      profile: structuredClone(
        initial?.profile || {
          identifier_label: 'Operator number',
          identifier_aliases: 'Cashier No, Operator No',
          date_instructions: 'Use the Generated timestamp and the printed report period.',
          columns: {},
        },
      ) as ReportProfile,
      official: initial?.official_metric_key || 'metric_1',
      confirmAdd: false,
      confirmRanking: false,
      modeDescriptions,
      get hasAdded(): boolean {
        return (
          !!initial && this.metrics.some((m) => !initial.metrics.some((old) => old.key === m.key))
        );
      },
      get rankingChanged(): boolean {
        return (
          !!initial &&
          (this.official !== initial.official_metric_key ||
            this.metrics.find((m) => m.key === this.official)?.direction !==
              initial.metrics.find((m) => m.key === initial.official_metric_key)?.direction)
        );
      },
      get publicMetrics(): Metric[] {
        return this.metrics.filter((m) => m.public);
      },
      addMetric() {
        if (this.metrics.length < 20)
          this.metrics.push(
            newMetric(`metric_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`),
          );
        this.confirmAdd = false;
      },
      removeMetric(key: string) {
        if (initial?.metrics.some((m) => m.key === key)) return;
        this.metrics = this.metrics.filter((m) => m.key !== key);
        if (!this.metrics.some((m) => m.key === this.official))
          this.official = this.metrics.find((m) => m.public)?.key || '';
      },
      isExisting(key: string) {
        return !!initial?.metrics.some((m) => m.key === key);
      },
      isLocked(key: string) {
        return initial?.lockedMetricKeys?.includes(key) || false;
      },
      changeType(metric: Metric) {
        metric.precision =
          metric.type === 'integer' ? 0 : metric.type === 'currency' ? 2 : metric.precision;
      },
      useTemplate() {
        const selected = templates.find((t) => String(t.id) === this.template);
        if (!selected) return;
        this.metrics = structuredClone(selected.metrics);
        this.profile = structuredClone(selected.profile);
        this.official = selected.official_metric_key;
        this.timezone = selected.timezone;
        this.multiple_items = selected.multiple_items || false;
        this.item_label = selected.item_label || 'Item';
        this.items = structuredClone(selected.items || []);
        this.notice = 'Template copied. Changes here apply only to this new competition.';
      },
      async discover() {
        if (options.allowSample === false) return;
        if (
          !this.file ||
          this.busy ||
          this.imageLoading ||
          this.detectingOrientation ||
          this.cropping ||
          !this.imagePreview
        )
          return;
        this.busy = true;
        this.error = '';
        this.notice = '';
        try {
          const body = new FormData();
          body.set('report', this.file);
          body.set('rotation', String(this.rotation));
          if (this.crop) body.set('crop', JSON.stringify(this.crop));
          const response = await fetch('/api/discover', { method: 'POST', body }),
            result = await response.json();
          if (!response.ok) throw new Error(result.error);
          this.metrics = result.metrics;
          this.profile = result.profile;
          this.official = this.metrics[0].key;
          this.notice =
            'Columns suggested from your sample. Confirm types, precision, currency and scoring modes below. The sample has not been imported.';
        } catch (e) {
          this.error = errorText(e);
        } finally {
          this.busy = false;
        }
      },
      next() {
        this.error = '';
        try {
          if (
            this.step === 1 &&
            (!this.name.trim() || !this.start_date || this.start_date > this.end_date)
          )
            throw new Error('Enter a competition name and valid date range.');
          if (this.step >= 2) {
            this.validateItems();
            validateMetrics(this.metrics);
            validateProfile(this.profile, this.metrics);
          }
          if (this.step === 3 && !this.publicMetrics.some((m) => m.key === this.official))
            throw new Error('Choose a public official ranking metric.');
          this.step = Math.min(4, this.step + 1);
        } catch (e) {
          this.error = errorText(e);
        }
      },
      async save() {
        if (this.busy) return;
        this.busy = true;
        this.error = '';
        try {
          this.validateItems();
          const result = await post(options.saveUrl || '/api/competition', {
            competition_id: initial?.id,
            schema_version: initial?.schema_version,
            name: this.name,
            start_date: this.start_date,
            end_date: this.end_date,
            timezone: this.timezone,
            is_active: this.is_active,
            multiple_items: this.multiple_items,
            item_label: this.item_label.trim() || 'Item',
            items: this.items,
            metrics: validateMetrics(this.metrics),
            profile: validateProfile(this.profile, this.metrics),
            official_metric_key: this.official,
            confirm_add: this.confirmAdd,
            confirm_ranking: this.confirmRanking,
          });
          const destination = new URL(options.successBase || '/competitions', location.origin);
          destination.pathname = `${destination.pathname.replace(/\/$/, '')}/${result.id}`;
          destination.searchParams.set('saved', '1');
          location.assign(destination.toString());
        } catch (e) {
          this.error = errorText(e);
        } finally {
          this.busy = false;
        }
      },
    }),
  );
  Alpine.data('reportEntry', (configs: Configuration[], initialId: number | null) => ({
    competitionId: String(initialId || configs[0]?.id || ''),
    report: blankReport(
      configs.find((c) => c.id === initialId)?.timezone ||
        configs[0]?.timezone ||
        'America/Chicago',
    ),
    offset: '',
    busy: false,
    error: '',
    message: '',
    modeDescriptions,
    get configuration(): Configuration | undefined {
      return configs.find((c) => String(c.id) === this.competitionId);
    },
    get multipleItems(): boolean {
      return this.configuration?.multiple_items || false;
    },
    get itemLabel(): string {
      return this.configuration?.item_label || 'Item';
    },
    get items(): TrackedItem[] {
      return this.configuration?.items || [];
    },
    get metrics(): Metric[] {
      return this.configuration?.metrics || [];
    },
    get identifierLabel(): string {
      return this.configuration?.profile.identifier_label || 'Operator number';
    },
    get timezone(): string {
      return this.configuration?.timezone || 'America/Chicago';
    },
    changeCompetition() {
      this.report = blankReport(this.timezone);
      this.offset = '';
      this.message = '';
      this.error = '';
    },
    addRow() {
      if (this.report.rows.length < 100) this.report.rows.push({ participant_id: '', values: {} });
    },
    async save() {
      if (!this.configuration || this.busy) return;
      this.busy = true;
      this.error = '';
      this.message = '';
      try {
        const result = await post('/api/reports', {
          competition_id: this.configuration.id,
          schema_version: this.configuration.schema_version,
          confirmed: true,
          report: { ...this.report, generated_at: this.report.generated_at + this.offset },
        });
        this.message = result.message;
        this.report = blankReport(this.timezone);
        this.offset = '';
      } catch (e) {
        this.error = errorText(e);
      } finally {
        this.busy = false;
      }
    },
  }));
  Alpine.data(
    'reportUpload',
    (
      initialDrafts: {
        token: string;
        competitionName: string;
        createdAt: number;
        expiresAt: number;
        revision: number;
      }[] = [],
      options: {
        mode?: 'baseline' | 'power-hour';
        sessionId?: number;
        name?: string;
        endsAt?: string;
      } = {},
    ) => ({
      uploadMode: options.mode || 'competition',
      powerHourEndsAt: options.endsAt || '',
      updatePowerHourSession(session: { id: number; ends_at: string } | null) {
        if (session && session.id === options.sessionId) this.powerHourEndsAt = session.ends_at;
      },
      get reportTimingWarning(): string {
        if (!this.powerHourEndsAt || !this.report?.generated_at) return '';
        try {
          return (
            powerHourTimingWarning(
              resolveReportTime(this.report.generated_at, this.timezone),
              this.powerHourEndsAt,
            ) || ''
          );
        } catch {
          return '';
        }
      },
      powerHourName: options.name || 'Power Hour',
      powerHourDuration: 60,
      powerHourMetric: '',
      draftQuery:
        options.mode === 'baseline'
          ? 'power_hour_baseline_draft'
          : options.mode === 'power-hour'
            ? 'power_hour_draft'
            : 'draft',
      ...reportImagePreview(),
      busy: false,
      error: '',
      message: '',
      token: '',
      revision: 0,
      expiresAt: 0,
      schemaChanged: false,
      multipleItems: false,
      itemLabel: 'Item',
      items: [] as TrackedItem[],
      addingItem: false,
      newItem: { code: '', name: '' },
      get detectedItemCode(): string {
        return this.originalReport?.item_code || '';
      },
      get needsItemSelection(): boolean {
        return (
          this.multipleItems && !this.items.some((item) => item.code === this.report?.item_code)
        );
      },
      originalReport: null as ReportInput | null,
      drafts: initialDrafts,
      centralReportTime,
      timezone: '',
      identifierLabel: '',
      metrics: [] as Metric[],
      report: null as ReportInput | null,
      reviewed: false,
      modeDescriptions,
      async init() {
        const token = new URLSearchParams(location.search).get(this.draftQuery);
        if (token) await this.reopen(token);
      },
      loadDraft(result: {
        token: string;
        revision: number;
        expiresAt: number;
        report: ReportInput;
        originalReport: ReportInput;
        metrics: Metric[];
        timezone: string;
        identifierLabel: string;
        schemaChanged: boolean;
        multipleItems?: boolean;
        itemLabel?: string;
        items?: TrackedItem[];
      }) {
        this.token = result.token;
        this.revision = result.revision;
        this.expiresAt = result.expiresAt;
        this.report = result.report;
        this.originalReport = result.originalReport;
        this.metrics = result.metrics;
        if (
          !this.metrics.some(
            (metric) =>
              String(metric.id) === this.powerHourMetric &&
              metric.public &&
              metric.mode !== 'additive',
          )
        )
          this.powerHourMetric = String(
            this.metrics.find((metric) => metric.public && metric.mode !== 'additive')?.id || '',
          );
        this.timezone = result.timezone;
        this.identifierLabel = result.identifierLabel;
        this.schemaChanged = result.schemaChanged;
        this.multipleItems = result.multipleItems || false;
        this.itemLabel = result.itemLabel || 'Item';
        this.items = result.items || [];
        if (this.multipleItems && !this.items.some((item) => item.code === this.report?.item_code))
          this.report.item_code = '';
        this.addingItem = false;
        this.reviewed = false;
        const url = new URL(location.href);
        url.searchParams.set(this.draftQuery, result.token);
        history.replaceState(null, '', url);
      },
      async addTrackedItem() {
        if (this.busy || this.schemaChanged || !this.report) return;
        this.busy = true;
        this.error = '';
        try {
          const result = await post('/api/drafts', {
            action: 'add_item',
            token: this.token,
            revision: this.revision,
            item: this.newItem,
            report: this.report,
          });
          this.loadDraft(result);
          this.newItem = { code: '', name: '' };
          this.message = result.message;
        } catch (error) {
          this.error = errorText(error);
        } finally {
          this.busy = false;
        }
      },
      async refreshDrafts() {
        const response = await fetch('/api/drafts', { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to load drafts.');
        this.drafts = result.drafts;
      },
      async reopen(token: string) {
        if (this.busy) return;
        this.busy = true;
        this.error = '';
        this.message = '';
        try {
          const response = await fetch('/api/drafts?token=' + encodeURIComponent(token), {
            cache: 'no-store',
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error);
          this.loadDraft(result);
        } catch (error) {
          this.error = errorText(error);
        } finally {
          this.busy = false;
        }
      },
      async saveDraft() {
        if (this.busy || !this.report || this.schemaChanged) return;
        this.busy = true;
        this.error = '';
        this.message = '';
        try {
          const result = await post('/api/drafts', {
            action: 'save',
            token: this.token,
            revision: this.revision,
            report: this.report,
          });
          this.loadDraft(result);
          this.message = result.message;
          await this.refreshDrafts();
        } catch (error) {
          this.error = errorText(error);
        } finally {
          this.busy = false;
        }
      },
      clearDraftUrl() {
        const url = new URL(location.href);
        url.searchParams.delete(this.draftQuery);
        history.replaceState(null, '', url);
      },
      async closeDraft() {
        if (this.busy) return;
        this.report = null;
        this.originalReport = null;
        this.token = '';
        this.reviewed = false;
        this.clearDraftUrl();
        this.message = '';
        this.error = '';
        try {
          await this.refreshDrafts();
        } catch (error) {
          this.error = errorText(error);
        }
      },
      async discard() {
        if (this.busy) return;
        this.busy = true;
        this.error = '';
        this.message = '';
        try {
          const result = await post('/api/drafts', {
            action: 'discard',
            token: this.token,
            revision: this.revision,
          });
          this.report = null;
          this.originalReport = null;
          this.token = '';
          this.reviewed = false;
          this.clearDraftUrl();
          this.message = result.message;
          await this.refreshDrafts();
        } catch (error) {
          this.error = errorText(error);
        } finally {
          this.busy = false;
        }
      },
      async upload(event: SubmitEvent) {
        if (
          this.busy ||
          this.imageLoading ||
          this.detectingOrientation ||
          this.cropping ||
          !this.file ||
          !this.imagePreview
        )
          return;
        this.busy = true;
        this.error = '';
        this.message = '';
        this.report = null;
        this.reviewed = false;
        try {
          const body = new FormData(event.target as HTMLFormElement);
          body.set('report', this.file);
          body.set('rotation', String(this.rotation));
          if (this.crop) body.set('crop', JSON.stringify(this.crop));
          const response = await fetch('/api/upload', { method: 'POST', body }),
            result = await response.json();
          if (!response.ok) throw new Error(result.error);
          this.loadDraft(result);
          await this.refreshDrafts();
          this.message = result.message;
        } catch (e) {
          this.error = errorText(e);
        } finally {
          this.busy = false;
        }
      },
      addRow() {
        if (this.report && this.report.rows.length < 100)
          this.report.rows.push({ participant_id: '', values: {} });
      },
      async confirm() {
        if (this.busy || !this.reviewed || this.schemaChanged || this.needsItemSelection) return;
        this.busy = true;
        this.error = '';
        this.message = '';
        try {
          const result = await post(
            options.mode === 'baseline'
              ? '/api/power-hour/start'
              : options.mode === 'power-hour'
                ? '/api/power-hour/reports'
                : '/api/reports',
            {
              token: this.token,
              revision: this.revision,
              report: this.report,
              confirmed: this.reviewed,
              ...(options.mode === 'power-hour' ? { session_id: options.sessionId } : {}),
              ...(options.mode === 'baseline'
                ? {
                    report_mode: true,
                    name: this.powerHourName,
                    duration_minutes: this.powerHourDuration,
                    report_metric_id: this.powerHourMetric,
                    baseline_token: this.token,
                    baseline_revision: this.revision,
                    baseline_report: this.report,
                  }
                : {}),
            },
          );
          this.message = result.message;
          this.report = null;
          this.originalReport = null;
          this.token = '';
          this.clearDraftUrl();
          this.reviewed = false;
          if (options.mode) {
            const destination =
              '/admin?success=1' +
              (options.mode === 'power-hour' ? '&power_hour_session=' + options.sessionId : '') +
              (result.warning ? '&warning=' + encodeURIComponent(result.warning) : '') +
              '#power-hour';
            if (location.pathname + location.search + location.hash === destination)
              location.reload();
            else location.assign(destination);
            return;
          }
          await this.refreshDrafts();
        } catch (e) {
          this.error = errorText(e);
        } finally {
          this.busy = false;
        }
      },
    }),
  );
}

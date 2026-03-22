const config = require('../../config/env');
const mailer = require('../../utils/mailer');

class BackupNotificationService {
  isEnabled() {
    return Boolean(
      config.backup.notifications.emailEnabled &&
        mailer.isEnabled() &&
        config.backup.notifications.recipients.length > 0
    );
  }

  _formatSize(sizeBytes) {
    const size = Number(sizeBytes || 0);
    if (size <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    const value = size / 1024 ** unitIndex;

    return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
  }

  _buildSubject(status) {
    return `${config.backup.notifications.subjectPrefix} ${status}`;
  }

  _escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _formatTimestamp(dateValue) {
    const date = new Date(dateValue || new Date());
    return {
      iso: date.toISOString(),
      human: date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'UTC',
        timeZoneName: 'short',
      }),
    };
  }

  _buildDetailRows(details) {
    return details
      .filter((detail) => detail && detail.value)
      .map(
        (detail) => `
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 13px; font-weight: 600; width: 170px; vertical-align: top;">
              ${this._escapeHtml(detail.label)}
            </td>
            <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; vertical-align: top;">
              ${detail.isHtml ? detail.value : this._escapeHtml(detail.value)}
            </td>
          </tr>
        `
      )
      .join('');
  }

  _renderEmailLayout({
    badgeText,
    badgeBackground,
    badgeColor,
    title,
    intro,
    details,
    actionLabel = '',
    actionUrl = '',
    noticeTitle = '',
    noticeBody = '',
    noticeBackground = '#f9fafb',
    noticeBorder = '#e5e7eb',
  }) {
    const detailsRows = this._buildDetailRows(details);
    const hasAction = Boolean(actionLabel && actionUrl);
    const hasNotice = Boolean(noticeTitle || noticeBody);

    return `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>${this._escapeHtml(title)}</title>
        </head>
        <body style="margin: 0; padding: 24px; background-color: #f3f4f6; font-family: Arial, Helvetica, sans-serif; color: #111827;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 18px; overflow: hidden; border: 1px solid #e5e7eb;">
            <tr>
              <td style="padding: 32px 32px 24px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);">
                <div style="display: inline-block; padding: 6px 12px; border-radius: 999px; background: ${badgeBackground}; color: ${badgeColor}; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;">
                  ${this._escapeHtml(badgeText)}
                </div>
                <h1 style="margin: 16px 0 8px; color: #ffffff; font-size: 26px; line-height: 1.25;">
                  ${this._escapeHtml(title)}
                </h1>
                <p style="margin: 0; color: #cbd5e1; font-size: 15px; line-height: 1.7;">
                  ${this._escapeHtml(intro)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding: 28px 32px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${detailsRows}
                </table>

                ${
                  hasAction
                    ? `
                  <div style="margin-top: 28px;">
                    <a href="${this._escapeHtml(actionUrl)}" style="display: inline-block; padding: 12px 18px; background: #0f766e; color: #ffffff; text-decoration: none; border-radius: 10px; font-size: 14px; font-weight: 700;">
                      ${this._escapeHtml(actionLabel)}
                    </a>
                  </div>
                `
                    : ''
                }

                ${
                  hasNotice
                    ? `
                  <div style="margin-top: 24px; padding: 16px 18px; background: ${noticeBackground}; border: 1px solid ${noticeBorder}; border-radius: 12px;">
                    ${
                      noticeTitle
                        ? `<div style="font-size: 14px; font-weight: 700; color: #111827; margin-bottom: 6px;">${this._escapeHtml(
                            noticeTitle
                          )}</div>`
                        : ''
                    }
                    ${
                      noticeBody
                        ? `<div style="font-size: 14px; line-height: 1.7; color: #374151;">${this._escapeHtml(
                            noticeBody
                          )}</div>`
                        : ''
                    }
                  </div>
                `
                    : ''
                }
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 32px 28px; background: #f9fafb; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; line-height: 1.7;">
                This is an automated backup notification from ${this._escapeHtml(config.site.name)}.
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
  }

  async sendSuccess({
    runId,
    trigger,
    fileName,
    sizeBytes,
    driveFileId,
    driveLink,
    completedAt,
    cleanupWarning = '',
  }) {
    if (!this.isEnabled()) {
      return false;
    }

    const recipients = config.backup.notifications.recipients.join(', ');
    const timestamp = this._formatTimestamp(completedAt);
    const warningBlock = cleanupWarning
      ? `\nCleanup warning: ${cleanupWarning}\nThe upload still succeeded, but local cleanup needs review.`
      : '';

    const text = [
      'MongoDB backup completed successfully.',
      '',
      `Time: ${timestamp.iso}`,
      `Trigger: ${trigger}`,
      `Run ID: ${runId}`,
      `File: ${fileName}`,
      `Size: ${this._formatSize(sizeBytes)} (${sizeBytes} bytes)`,
      `Google Drive file ID: ${driveFileId}`,
      `Google Drive link: ${driveLink}`,
      warningBlock.trim(),
    ]
      .filter(Boolean)
      .join('\n');

    const html = this._renderEmailLayout({
      badgeText: 'Backup Success',
      badgeBackground: '#dcfce7',
      badgeColor: '#166534',
      title: 'MongoDB Backup Completed Successfully',
      intro:
        'The scheduled backup finished successfully and the archive was uploaded to Google Drive.',
      details: [
        { label: 'System', value: config.site.name },
        { label: 'Completed At', value: timestamp.human },
        { label: 'Trigger', value: trigger },
        { label: 'Run ID', value: runId },
        { label: 'Backup File', value: fileName },
        { label: 'Archive Size', value: `${this._formatSize(sizeBytes)} (${sizeBytes} bytes)` },
        { label: 'Drive File ID', value: driveFileId },
        {
          label: 'Drive Link',
          value: `<a href="${this._escapeHtml(
            driveLink
          )}" style="color: #0f766e; text-decoration: none; font-weight: 600;">Open backup in Google Drive</a>`,
          isHtml: true,
        },
      ],
      actionLabel: 'Open In Google Drive',
      actionUrl: driveLink,
      noticeTitle: cleanupWarning ? 'Cleanup Warning' : '',
      noticeBody: cleanupWarning
        ? `${cleanupWarning} The upload succeeded, but local cleanup should be reviewed.`
        : '',
      noticeBackground: '#fff7ed',
      noticeBorder: '#fdba74',
    });

    await mailer.sendMail({
      to: recipients,
      subject: this._buildSubject('SUCCESS'),
      text,
      html,
    });

    return true;
  }

  async sendFailure({
    runId,
    trigger,
    stage,
    reason,
    fileName = '',
    localFilePath = '',
    occurredAt,
  }) {
    if (!this.isEnabled()) {
      return false;
    }

    const recipients = config.backup.notifications.recipients.join(', ');
    const timestamp = this._formatTimestamp(occurredAt);

    const text = [
      'MongoDB backup failed.',
      '',
      `Time: ${timestamp.iso}`,
      `Trigger: ${trigger}`,
      `Run ID: ${runId}`,
      `Stage: ${stage || 'unknown'}`,
      `Reason: ${reason}`,
      fileName ? `File: ${fileName}` : '',
      localFilePath ? `Local file kept: ${localFilePath}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const html = this._renderEmailLayout({
      badgeText: 'Backup Failed',
      badgeBackground: '#fee2e2',
      badgeColor: '#991b1b',
      title: 'MongoDB Backup Failed',
      intro:
        'The backup process encountered an error and requires attention before the next scheduled run.',
      details: [
        { label: 'System', value: config.site.name },
        { label: 'Occurred At', value: timestamp.human },
        { label: 'Trigger', value: trigger },
        { label: 'Run ID', value: runId },
        { label: 'Stage', value: stage || 'unknown' },
        { label: 'Reason', value: reason },
        { label: 'Backup File', value: fileName },
        { label: 'Local File Preserved', value: localFilePath },
      ],
      noticeTitle: 'Recommended Action',
      noticeBody:
        'Review the backup logs, confirm Google Drive and MongoDB connectivity, and rerun the backup once the issue is resolved.',
      noticeBackground: '#fef2f2',
      noticeBorder: '#fca5a5',
    });

    await mailer.sendMail({
      to: recipients,
      subject: this._buildSubject('FAILED'),
      text,
      html,
    });

    return true;
  }
}

module.exports = new BackupNotificationService();

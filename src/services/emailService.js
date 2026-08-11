'use strict';

const nodemailer = require('nodemailer');

// ---------------------------------------------------------------------------
// Transport configuration
// ---------------------------------------------------------------------------

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const DEFAULT_FROM =
  process.env.SMTP_FROM || `"Certified Australia" <${process.env.SMTP_USER}>`;

// ---------------------------------------------------------------------------
// Design system tokens
// ---------------------------------------------------------------------------

const T = {
  primary: '#0a9d42',
  primaryDark: '#078434',
  primaryLight: '#e8f5ed',
  primaryBorder: '#c3e6cf',

  success: '#0a9d42',
  successBg: '#e8f5ed',
  successBorder: '#a7d7b8',

  warning: '#d97706',
  warningBg: '#fffbeb',
  warningBorder: '#fcd34d',

  danger: '#dc2626',
  dangerBg: '#fef2f2',
  dangerBorder: '#fca5a5',

  info: '#0369a1',
  infoBg: '#eff6ff',
  infoBorder: '#93c5fd',

  textPrimary: '#1A1F2E',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  textMuted: '#6B7280',

  pageBg: '#EEF5F0',
  cardBg: '#ffffff',
  footerBg: '#f0faf5',
  dividerColor: '#E5E7EB',

  headerGradient: 'linear-gradient(135deg, #e8f5ed 0%, #d1edd9 50%, #bbdfc6 100%)',
  btnGradient: 'linear-gradient(135deg, #0a9d42 0%, #078434 100%)',
  btnSecondaryBorder: '#0a9d42',
  footerGradient: 'linear-gradient(135deg, #e8f5ed 0%, #d1edd9 100%)',

  cardShadow: '0 2px 16px rgba(10,157,66,0.08),0 1px 4px rgba(0,0,0,0.04)',
  btnShadow: '0 4px 12px rgba(10,157,66,0.35)',
  cardBorderRadius: '14px',

  fontStack: "'Inter','Segoe UI',Helvetica,Arial,sans-serif",
  logoUrl: 'https://logosca.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(18).png',
};

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------

const heading2 = (text) =>
  `<h2 style="margin:0 0 12px 0;font-family:${T.fontStack};font-size:20px;font-weight:700;color:${T.textPrimary};letter-spacing:-0.3px;line-height:1.3;">${text}</h2>`;

const heading3 = (text) =>
  `<h3 style="margin:22px 0 10px 0;font-family:${T.fontStack};font-size:16px;font-weight:700;color:${T.textPrimary};line-height:1.4;">${text}</h3>`;

const paragraph = (text, style = '') =>
  `<p style="margin:0 0 16px 0;font-family:${T.fontStack};font-size:15px;line-height:1.7;color:${T.textSecondary};${style}">${text}</p>`;

const _list = (tag, items) =>
  `<${tag} style="margin:0 0 16px 0;padding:0 0 0 22px;">` +
    items.map((item) =>
      `<li style="font-family:${T.fontStack};font-size:15px;line-height:1.7;color:${T.textSecondary};margin-bottom:6px;">${item}</li>`
    ).join('') +
  `</${tag}>`;

const bulletList = (items) => _list('ul', items);

const numberedList = (items) => _list('ol', items);

const greeting = (name) =>
  `<p style="margin:0 0 20px 0;font-family:${T.fontStack};font-size:16px;line-height:1.6;color:${T.textPrimary};font-weight:500;">Hi <strong style="color:${T.primary};">${name}</strong>,</p>`;

const signOff = () =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:28px 0 4px 0;">` +
    `<tr><td style="padding-bottom:20px;">` +
      `<div style="height:1px;background:linear-gradient(90deg,${T.primaryLight} 0%,${T.primaryBorder} 50%,${T.primaryLight} 100%);"></div>` +
    `</td></tr>` +
    `<tr><td style="font-family:${T.fontStack};font-size:14px;line-height:1.6;color:${T.textSecondary};">` +
      `<p style="margin:0 0 2px 0;">Warm regards,</p>` +
      `<p style="margin:0;font-weight:700;color:${T.textPrimary};">The Certified Australia Team</p>` +
      `<p style="margin:4px 0 0 0;font-size:12px;color:${T.textTertiary};">` +
        `<a href="https://certifiedaustralia.com.au" target="_blank" style="color:${T.primary};text-decoration:none;">certifiedaustralia.com.au</a>` +
      `</p>` +
    `</td></tr>` +
  `</table>`;

const primaryButton = (text, url) =>
  `<!--[if mso]>` +
  `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="20%" fillcolor="#0a9d42" stroke="f">` +
    `<w:anchorlock/>` +
    `<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${text}</center>` +
  `</v:roundrect>` +
  `<![endif]-->` +
  `<!--[if !mso]><!-->` +
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0;">` +
    `<tr><td style="border-radius:10px;background:${T.btnGradient};box-shadow:${T.btnShadow};">` +
      `<a href="${url}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${T.fontStack};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:0.2px;">${text}</a>` +
    `</td></tr>` +
  `</table>` +
  `<!--<![endif]-->`;

const secondaryButton = (text, url) =>
  `<!--[if mso]>` +
  `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="20%" fillcolor="#ffffff" strokecolor="#0a9d42">` +
    `<w:anchorlock/>` +
    `<center style="color:#0a9d42;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${text}</center>` +
  `</v:roundrect>` +
  `<![endif]-->` +
  `<!--[if !mso]><!-->` +
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0;">` +
    `<tr><td style="border-radius:10px;background:#ffffff;border:2px solid ${T.btnSecondaryBorder};">` +
      `<a href="${url}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${T.fontStack};font-size:15px;font-weight:700;color:${T.primary};text-decoration:none;border-radius:8px;letter-spacing:0.2px;">${text}</a>` +
    `</td></tr>` +
  `</table>` +
  `<!--<![endif]-->`;

const buttonGroup = (primary, secondary) =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">` +
    `<tr>` +
      `<td style="padding-right:${secondary ? '12' : '0'}px;">${primaryButton(primary.text, primary.url)}</td>` +
      (secondary ? `<td>${secondaryButton(secondary.text, secondary.url)}</td>` : '') +
    `</tr>` +
  `</table>`;

const _card = (accent, bg, border, title, content, titlePrefix) => {
  const titleHtml = title
    ? `<p style="margin:0 0 6px 0;font-family:${T.fontStack};font-size:13px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:0.6px;">${titlePrefix || ''}${title}</p>`
    : '';
  const bodyHtml = `<p style="margin:0;font-family:${T.fontStack};font-size:14px;line-height:1.7;color:${T.textSecondary};">${content}</p>`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0;">` +
    `<tr>` +
      `<td style="background:${accent};width:4px;border-radius:12px 0 0 12px;"></td>` +
      `<td style="padding:16px 18px;background:${bg};border:1px solid ${border};border-left:none;border-radius:0 12px 12px 0;">` +
        titleHtml + bodyHtml +
      `</td>` +
    `</tr>` +
  `</table>`;
};

const infoCard = (title, items) => {
  const bodyHtml = Array.isArray(items)
    ? '<ul style="margin:0;padding:0 0 0 18px;">' +
        items.map((item) =>
          `<li style="font-family:${T.fontStack};font-size:14px;line-height:1.7;color:${T.textSecondary};margin-bottom:4px;">${item}</li>`
        ).join('') +
      '</ul>'
    : `<p style="margin:0;font-family:${T.fontStack};font-size:14px;line-height:1.7;color:${T.textSecondary};">${items}</p>`;

  const titleHtml = title
    ? `<p style="margin:0 0 8px 0;font-family:${T.fontStack};font-size:13px;font-weight:700;color:${T.primary};text-transform:uppercase;letter-spacing:0.6px;">${title}</p>`
    : '';

  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0;">` +
    `<tr>` +
      `<td style="background:${T.primary};width:4px;border-radius:12px 0 0 12px;"></td>` +
      `<td style="padding:16px 18px;background:${T.primaryLight};border:1px solid ${T.primaryBorder};border-left:none;border-radius:0 12px 12px 0;">` +
        titleHtml + bodyHtml +
      `</td>` +
    `</tr>` +
  `</table>`;
};

const successCard = (title, content) => _card(T.success, T.successBg, T.successBorder, title, content, '&#10003; ');
const warningCard = (title, content) => _card(T.warning, T.warningBg, T.warningBorder, title, content, '&#9888; ');
const dangerCard = (title, content) => _card(T.danger, T.dangerBg, T.dangerBorder, title, content, '&#9888; ');

const detailRow = (label, value) =>
  `<tr>` +
    `<td style="padding:10px 0;border-bottom:1px solid ${T.dividerColor};font-family:${T.fontStack};font-size:13px;color:${T.textTertiary};font-weight:600;text-transform:uppercase;letter-spacing:0.4px;width:40%;vertical-align:top;">${label}</td>` +
    `<td style="padding:10px 0 10px 16px;border-bottom:1px solid ${T.dividerColor};font-family:${T.fontStack};font-size:14px;color:${T.textPrimary};font-weight:500;vertical-align:top;">${value}</td>` +
  `</tr>`;

const detailsTable = (title, rows) =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0;border-radius:12px;background:${T.cardBg};border:1px solid ${T.primaryBorder};overflow:hidden;box-shadow:${T.cardShadow};">` +
    `<tr><td style="padding:18px 20px 0 20px;border-bottom:2px solid ${T.primaryLight};">` +
      `<p style="margin:0 0 12px 0;font-family:${T.fontStack};font-size:14px;font-weight:700;color:${T.primary};text-transform:uppercase;letter-spacing:0.6px;">${title}</p>` +
    `</td></tr>` +
    `<tr><td style="padding:0 20px 8px 20px;">` +
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">` +
        rows.map((r) => detailRow(r.label, r.value)).join('') +
      `</table>` +
    `</td></tr>` +
  `</table>`;

const statusBadge = (text, type = 'default') => {
  const styles = {
    success: { bg: T.successBg, color: T.success, border: T.successBorder },
    danger: { bg: T.dangerBg, color: T.danger, border: T.dangerBorder },
    warning: { bg: T.warningBg, color: T.warning, border: T.warningBorder },
    info: { bg: T.infoBg, color: T.info, border: T.infoBorder },
    default: { bg: '#F3F4F6', color: T.textSecondary, border: '#D1D5DB' },
  };
  const s = styles[type] || styles.default;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:20px;background:${s.bg};color:${s.color};border:1px solid ${s.border};font-family:${T.fontStack};font-size:12px;font-weight:700;letter-spacing:0.3px;white-space:nowrap;">${text}</span>`;
};

const statusItem = (label, status, isDone) => {
  const iconBg = isDone ? T.success : T.warningBg;
  const iconBorder = isDone ? '' : `border:2px solid ${T.warning};`;
  const iconColor = isDone ? '#fff' : T.warning;
  const iconChar = isDone ? '&#10003;' : '!';
  const iconLine = isDone ? '20px' : '16px';

  return `<tr>` +
    `<td style="padding:8px 0;border-bottom:1px solid ${T.dividerColor};">` +
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">` +
        `<tr>` +
          `<td width="28" valign="middle" style="vertical-align:middle;">` +
            `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>` +
              `<td style="width:20px;height:20px;border-radius:50%;background:${iconBg};${iconBorder}text-align:center;line-height:${iconLine};font-size:12px;color:${iconColor};font-weight:700;font-family:${T.fontStack};">${iconChar}</td>` +
            `</tr></table>` +
          `</td>` +
          `<td valign="middle" style="vertical-align:middle;font-family:${T.fontStack};font-size:14px;color:${T.textPrimary};font-weight:500;padding-left:10px;">${label}</td>` +
          `<td valign="middle" style="vertical-align:middle;text-align:right;">${statusBadge(status, isDone ? 'success' : 'warning')}</td>` +
        `</tr>` +
      `</table>` +
    `</td>` +
  `</tr>`;
};

const divider = () =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;">` +
    `<tr><td style="height:1px;background:linear-gradient(90deg,transparent 0%,${T.primaryBorder} 30%,${T.primaryBorder} 70%,transparent 100%);"></td></tr>` +
  `</table>`;

const smallText = (text) =>
  `<p style="margin:0 0 10px 0;font-family:${T.fontStack};font-size:12px;line-height:1.6;color:${T.textTertiary};">${text}</p>`;

const personalMessage = (message, sender) =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0;border-radius:12px;background:#fafffe;border:1px solid ${T.primaryBorder};">` +
    `<tr><td style="padding:18px 20px;">` +
      `<p style="margin:0 0 ${sender ? '12' : '0'}px;font-family:${T.fontStack};font-size:15px;line-height:1.8;color:${T.textPrimary};font-style:italic;">&ldquo;${message}&rdquo;</p>` +
      (sender ? `<p style="margin:0;font-family:${T.fontStack};font-size:13px;color:${T.textSecondary};font-weight:600;">&mdash; ${sender}</p>` : '') +
    `</td></tr>` +
  `</table>`;

// ---------------------------------------------------------------------------
// Shell builder
// ---------------------------------------------------------------------------

const buildEmail = (bodyContent, preheader = '') => {
  const year = new Date().getFullYear();

  const preheaderBlock = preheader
    ? `<div aria-hidden="true" style="display:none;font-size:1px;color:${T.pageBg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : '';

  return '<!DOCTYPE html>' +
'<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">' +
'<head>' +
  '<meta charset="utf-8"/>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
  '<meta http-equiv="X-UA-Compatible" content="IE=edge"/>' +
  '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no"/>' +
  '<title>Certified Australia</title>' +
  '<!--[if mso]>' +
  '<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>' +
  '<style>table,td{font-family:Arial,Helvetica,sans-serif!important}</style>' +
  '<![endif]-->' +
  '<style>' +
    'body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}' +
    'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}' +
    'img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;display:block}' +
    `body{margin:0;padding:0;width:100%!important;background-color:${T.pageBg}}` +
    `a{color:${T.primary};text-decoration:underline}` +
    '@media only screen and (max-width:620px){' +
      '.email-wrapper{padding:12px 8px!important}' +
      '.email-container{width:100%!important;border-radius:10px!important}' +
      '.email-body{padding:24px 20px!important}' +
      '.email-header{padding:24px 20px 20px 20px!important}' +
      '.email-footer{padding:20px!important}' +
    '}' +
  '</style>' +
'</head>' +
`<body style="margin:0;padding:0;background-color:${T.pageBg};">` +
  preheaderBlock +
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${T.pageBg};">` +
    `<tr><td align="center" class="email-wrapper" style="padding:32px 16px;">` +
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="email-container" style="max-width:600px;width:100%;background-color:${T.cardBg};border-radius:${T.cardBorderRadius};box-shadow:${T.cardShadow};overflow:hidden;">` +

        // HEADER
        `<tr><td class="email-header" align="center" style="padding:36px 40px 28px 40px;text-align:center;background:${T.headerGradient};border-bottom:3px solid ${T.primaryBorder};">` +
          `<img src="${T.logoUrl}" alt="Certified Australia" width="200" style="max-width:200px;height:auto;display:block;margin:0 auto;"/>` +
        `</td></tr>` +

        // BODY
        `<tr><td class="email-body" style="padding:36px 40px 28px 40px;font-family:${T.fontStack};font-size:15px;line-height:1.7;color:${T.textSecondary};">` +
          bodyContent +
        `</td></tr>` +

        // FOOTER
        `<tr><td class="email-footer" align="center" style="padding:24px 40px;background:${T.footerGradient};border-top:1px solid ${T.primaryBorder};text-align:center;font-family:${T.fontStack};">` +
          `<p style="margin:0 0 6px 0;font-size:13px;font-weight:600;color:${T.textSecondary};">Certified Australia Group Pty Ltd</p>` +
          `<p style="margin:0 0 10px 0;font-size:12px;color:${T.textTertiary};">&copy; ${year} All rights reserved.</p>` +
          `<p style="margin:0;font-size:11px;color:${T.textTertiary};line-height:1.6;">This is an automated message. Please do not reply directly to this email.</p>` +
        `</td></tr>` +

      `</table>` +
    `</td></tr>` +
  `</table>` +
'</body>' +
'</html>';
};

// ---------------------------------------------------------------------------
// Backward-compatible wrapper
// ---------------------------------------------------------------------------

const buildEmailHtml = (content, opts = {}) => {
  const { preheader, ctaText, ctaUrl } = opts;
  const ctaBlock = (ctaText && ctaUrl)
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;"><tr><td>${primaryButton(ctaText, ctaUrl)}</td></tr></table>`
    : '';
  return buildEmail(`${content}${ctaBlock}`, preheader);
};

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

const sendEmail = async ({ to, subject, html, text, attachments }) => {
  try {
    const info = await transporter.sendMail({
      from: DEFAULT_FROM,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
      text,
      attachments,
    });
    console.log('[EmailService] Sent to %s — messageId: %s', to, info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[EmailService] Failed to send to %s:', to, err.message);
    return { success: false, error: err };
  }
};

const sendTemplatedEmail = async ({ to, subject, templateContent, ctaText, ctaUrl, preheader, attachments }) => {
  const html = buildEmailHtml(templateContent, { ctaText, ctaUrl, preheader });
  return sendEmail({ to, subject, html, attachments });
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  T,
  buildEmail,
  heading2,
  heading3,
  paragraph,
  bulletList,
  numberedList,
  greeting,
  signOff,
  primaryButton,
  secondaryButton,
  buttonGroup,
  infoCard,
  successCard,
  warningCard,
  dangerCard,
  detailRow,
  detailsTable,
  statusBadge,
  statusItem,
  divider,
  smallText,
  personalMessage,
  buildEmailHtml,
  sendEmail,
  sendTemplatedEmail,
};

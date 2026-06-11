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
// Branded HTML wrapper
// ---------------------------------------------------------------------------

/**
 * Build a fully branded, mobile-responsive HTML email.
 *
 * @param {string} content  - Inner HTML body (paragraphs, headings, etc.)
 * @param {object} [opts]
 * @param {string} [opts.preheader]  - Hidden preheader text for inbox previews
 * @param {string} [opts.ctaText]    - Call-to-action button label
 * @param {string} [opts.ctaUrl]     - Call-to-action button URL
 * @returns {string} Full HTML document
 */
const buildEmailHtml = (content, opts = {}) => {
  const { preheader, ctaText, ctaUrl } = opts;

  const ctaBlock =
    ctaText && ctaUrl
      ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px auto;">
           <tr>
             <td style="border-radius:6px;background-color:#0a9d42;">
               <a href="${ctaUrl}" target="_blank"
                  style="display:inline-block;padding:14px 32px;font-family:'Inter',Helvetica,Arial,sans-serif;
                         font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
                 ${ctaText}
               </a>
             </td>
           </tr>
         </table>`
      : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <title>Certified Australia</title>
  <!--[if mso]>
  <style>table,td{font-family:Arial,Helvetica,sans-serif!important;}</style>
  <![endif]-->
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
    table,td{mso-table-lspace:0;mso-table-rspace:0;}
    img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}
    body{margin:0;padding:0;width:100%!important;background-color:#f4f5f7;}
    a{color:#0a9d42;text-decoration:underline;}
    @media only screen and (max-width:600px){
      .email-container{width:100%!important;padding:16px!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;">
  ${preheader ? `<div style="display:none;font-size:1px;color:#f4f5f7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ''}

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
         style="background-color:#f4f5f7;">
    <tr>
      <td align="center" style="padding:24px 16px;">

        <!-- Email container -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"
               class="email-container"
               style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;
                      box-shadow:0 2px 8px rgba(0,0,0,0.06);">

          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 16px 40px;text-align:center;
                        border-bottom:3px solid #0a9d42;border-radius:12px 12px 0 0;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td align="center" style="font-family:'Inter',Helvetica,Arial,sans-serif;
                                             font-size:24px;font-weight:700;color:#0a9d42;
                                             letter-spacing:-0.5px;">
                    Certified Australia
                  </td>
                </tr>
                <tr>
                  <td align="center"
                      style="padding-top:4px;font-family:'Inter',Helvetica,Arial,sans-serif;
                             font-size:12px;color:#6b7280;letter-spacing:1px;text-transform:uppercase;">
                    RPL Portal
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;font-family:'Inter',Helvetica,Arial,sans-serif;
                        font-size:15px;line-height:1.6;color:#1f2937;">
              ${content}
              ${ctaBlock}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;background-color:#f9fafb;border-radius:0 0 12px 12px;
                        border-top:1px solid #e5e7eb;text-align:center;
                        font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;
                        line-height:1.5;color:#9ca3af;">
              <p style="margin:0 0 4px 0;">&copy; ${new Date().getFullYear()} Certified Australia Pty Ltd. All rights reserved.</p>
              <p style="margin:0;">This is an automated message. Please do not reply directly to this email.</p>
            </td>
          </tr>

        </table>
        <!-- /Email container -->

      </td>
    </tr>
  </table>
</body>
</html>`;
};

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

/**
 * Send a raw email.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.html]
 * @param {string} [opts.text]
 * @param {Array}  [opts.attachments] - Nodemailer attachment objects
 * @returns {Promise<{success: boolean, messageId?: string, error?: Error}>}
 */
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

/**
 * Send an email wrapped in the branded HTML template.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.templateContent - Inner HTML (paragraphs etc.)
 * @param {string} [opts.ctaText]
 * @param {string} [opts.ctaUrl]
 * @param {string} [opts.preheader]
 * @param {Array}  [opts.attachments]
 * @returns {Promise<{success: boolean, messageId?: string, error?: Error}>}
 */
const sendTemplatedEmail = async ({
  to,
  subject,
  templateContent,
  ctaText,
  ctaUrl,
  preheader,
  attachments,
}) => {
  const html = buildEmailHtml(templateContent, { ctaText, ctaUrl, preheader });
  return sendEmail({ to, subject, html, attachments });
};

module.exports = {
  buildEmailHtml,
  sendEmail,
  sendTemplatedEmail,
};

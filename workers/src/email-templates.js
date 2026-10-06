// Transactional email templates for Proof Inspections.
// https://inspections.lodgingconnections.com
// Brand: Proof Inspections — primary green #0d7a5f, dark #0a5f4b, Inter font.
// Table-based, max-width 600px, mobile-friendly. No external dependencies.
//
// Usage:
//   import { TEMPLATES } from './email-templates.js';
//   const { subject, html, text } = TEMPLATES.order_confirmation({ ...vars });

/** Escape user-controlled content for safe HTML interpolation. */
const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Short order id for subjects: last 6 chars, e.g. "#A3F9K2". */
const shortId = (orderId) => {
  const s = String(orderId || '').replace(/[^A-Za-z0-9]/g, '');
  return s ? s.slice(-6).toUpperCase() : 'order';
};

const BRAND = {
  name: 'Proof Inspections',
  url: 'https://inspections.lodgingconnections.com',
  email: 'hello@proofinspections.com',
  phone: '(814) 555-0199',
  green: '#0d7a5f',
  dark: '#0a5f4b',
  ink: '#1a1a1a',
  gray: '#5f6368',
  light: '#f4f7f6',
  border: '#e5ebe9',
};

/**
 * Shared email shell: table-based, 600px, header/footer, preheader support.
 * @param {{preheader:string, title:string, body:string}} opts
 */
const shell = ({ preheader = '', title = '', body = '' }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body { margin: 0; padding: 0; background-color: #f4f7f6; }
  .wrapper { width: 100%; background-color: #f4f7f6; padding: 24px 0; }
  .container { width: 600px; max-width: 100%; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; }
  .pad { padding: 32px; }
  .h1 { font-size: 22px; line-height: 1.35; font-weight: 700; color: #1a1a1a; margin: 0 0 12px 0; }
  .p { font-size: 15px; line-height: 1.6; color: #3c4043; margin: 0 0 16px 0; }
  .small { font-size: 13px; line-height: 1.6; color: #5f6368; }
  .btn { display: inline-block; background-color: #0d7a5f; color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 15px; padding: 13px 28px; border-radius: 8px; }
  .btn:hover { background-color: #0a5f4b; }
  .btn-wrap { text-align: center; padding: 8px 0 16px 0; }
  .code { font-size: 32px; font-weight: 700; letter-spacing: 10px; color: #0a5f4b; text-align: center; font-family: 'Inter', Arial, sans-serif; }
  .codebox { background-color: #f4f7f6; border: 1px solid #e5ebe9; border-radius: 10px; padding: 20px 16px; text-align: center; margin: 20px 0; }
  .card { background-color: #f4f7f6; border: 1px solid #e5ebe9; border-radius: 10px; padding: 18px 20px; margin: 0 0 16px 0; }
  .row-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #5f6368; margin: 0 0 2px 0; }
  .row-value { font-size: 15px; color: #1a1a1a; margin: 0 0 12px 0; }
  .row-value:last-child { margin-bottom: 0; }
  .step-num { width: 28px; height: 28px; background-color: #0d7a5f; color: #ffffff; border-radius: 50%; font-size: 14px; font-weight: 700; text-align: center; line-height: 28px; display: inline-block; }
  .step-title { font-size: 15px; font-weight: 600; color: #1a1a1a; margin: 0 0 2px 0; }
  .step-desc { font-size: 14px; color: #5f6368; margin: 0; line-height: 1.5; }
  .digest { font-family: monospace, monospace; font-size: 13px; color: #0a5f4b; word-break: break-all; }
  .footer { padding: 24px 32px; background-color: #0a5f4b; }
  .footer p { font-size: 13px; line-height: 1.6; color: #c8e6dd; margin: 0 0 8px 0; }
  .footer a { color: #ffffff; text-decoration: none; }
  @media only screen and (max-width: 620px) {
    .pad { padding: 24px 20px; }
    .code { font-size: 26px; letter-spacing: 6px; }
    .h1 { font-size: 20px; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f4f7f6;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="wrapper" style="background-color:#f4f7f6;padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="container" style="width:600px;max-width:100%;margin:0 auto;background-color:#ffffff;border-radius:12px;">
    <tr><td style="background-color:#0a5f4b;padding:22px 32px;">
      <span style="font-family:'Inter',Arial,sans-serif;font-size:18px;font-weight:700;color:#ffffff;">&#10003; Proof Inspections</span>
    </td></tr>
    <tr><td class="pad" style="padding:32px;font-family:'Inter',Arial,sans-serif;">
${body}
    </td></tr>
    <tr><td class="footer" style="background-color:#0a5f4b;padding:24px 32px;">
      <p style="font-size:13px;line-height:1.6;color:#c8e6dd;margin:0 0 8px 0;">Questions? Reply to this email or reach us at <a href="mailto:${esc(BRAND.email)}" style="color:#ffffff;">${esc(BRAND.email)}</a> &middot; ${esc(BRAND.phone)}</p>
      <p style="font-size:13px;line-height:1.6;color:#c8e6dd;margin:0;">&copy; ${new Date().getFullYear()} ${esc(BRAND.name)}. <a href="${esc(BRAND.url)}" style="color:#ffffff;">inspections.lodgingconnections.com</a></p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

const button = (url, label) => `<div class="btn-wrap" style="text-align:center;padding:8px 0 16px 0;">
  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${esc(url)}" style="width:260px;height:46px;" arcsize="17%" fillcolor="#0d7a5f" stroke="f"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:600;">${esc(label)}</center></v:roundrect><![endif]-->
  <!--[if !mso]><!--><a href="${esc(url)}" class="btn" style="display:inline-block;background-color:#0d7a5f;color:#ffffff !important;text-decoration:none;font-weight:600;font-size:15px;padding:13px 28px;border-radius:8px;">${esc(label)}</a><!--<![endif]-->
</div>`;

export const TEMPLATES = {
  // ── 1. Passwordless login code ─────────────────────────────────────
  login_code: {
    subject: (vars) => `Your Proof Inspections sign-in code`,
    html: (vars) => {
      const code = String(vars.code || '').toUpperCase();
      const mins = Number(vars.expiresMinutes) || 15;
      return shell({
        preheader: `Your sign-in code is ${code}. It expires in ${mins} minutes.`,
        title: 'Your sign-in code',
        body: `
      <h1 class="h1" style="font-size:22px;font-weight:700;color:#1a1a1a;margin:0 0 12px 0;">Your sign-in code</h1>
      <p class="p" style="font-size:15px;line-height:1.6;color:#3c4043;margin:0 0 16px 0;">Enter this code to sign in to your Proof Inspections account. It expires in <strong>${mins} minutes</strong>.</p>
      <div class="codebox" style="background-color:#f4f7f6;border:1px solid #e5ebe9;border-radius:10px;padding:20px 16px;text-align:center;margin:20px 0;">
        <span class="code" style="font-size:32px;font-weight:700;letter-spacing:10px;color:#0a5f4b;">${esc(code)}</span>
      </div>
      <p class="small" style="font-size:13px;line-height:1.6;color:#5f6368;">Never share this code with anyone. If you didn't request it, you can safely ignore this email.</p>`,
      });
    },
    text: (vars) => {
      const code = String(vars.code || '').toUpperCase();
      const mins = Number(vars.expiresMinutes) || 15;
      return `Your Proof Inspections sign-in code

Enter this code to sign in: ${code}

It expires in ${mins} minutes.

Never share this code with anyone. If you didn't request it, you can safely ignore this email.

Questions? ${BRAND.email} / ${BRAND.phone}`;
    },
  },

  // ── 2. Order confirmation ──────────────────────────────────────────
  order_confirmation: {
    subject: (vars) => `Order confirmed — inspection #${shortId(vars.orderId)}`,
    html: (vars) => {
      const name = vars.customerName || '';
      const trackUrl = vars.trackUrl || BRAND.url;
      const sid = shortId(vars.orderId);
      return shell({
        preheader: `Inspection #${sid} is confirmed. We'll dispatch your inspector within 2 business days.`,
        title: `Order confirmed — inspection #${sid}`,
        body: `
      <h1 class="h1" style="font-size:22px;font-weight:700;color:#1a1a1a;margin:0 0 12px 0;">Order confirmed${name ? `, ${esc(name)}` : ''}</h1>
      <p class="p" style="font-size:15px;line-height:1.6;color:#3c4043;margin:0 0 16px 0;">Your inspection is booked. Here's what happens next:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        <tr>
          <td width="40" valign="top" style="padding-bottom:16px;"><span class="step-num" style="width:28px;height:28px;background-color:#0d7a5f;color:#ffffff;border-radius:50%;font-size:14px;font-weight:700;text-align:center;line-height:28px;display:inline-block;">1</span></td>
          <td valign="top" style="padding-bottom:16px;"><p class="step-title" style="font-size:15px;font-weight:600;color:#1a1a1a;margin:0 0 2px 0;">Inspector dispatched</p><p class="step-desc" style="font-size:14px;color:#5f6368;margin:0;line-height:1.5;">A licensed inspector is assigned within 2 business days and you'll get an email with their name.</p></td>
        </tr>
        <tr>
          <td width="40" valign="top" style="padding-bottom:16px;"><span class="step-num" style="width:28px;height:28px;background-color:#0d7a5f;color:#ffffff;border-radius:50%;font-size:14px;font-weight:700;text-align:center;line-height:28px;display:inline-block;">2</span></td>
          <td valign="top" style="padding-bottom:16px;"><p class="step-title" style="font-size:15px;font-weight:600;color:#1a1a1a;margin:0 0 2px 0;">Evidence sealed</p><p class="step-desc" style="font-size:14px;color:#5f6368;margin:0;line-height:1.5;">Every photo and finding is cryptographically sealed at capture — tamper-evident from day one.</p></td>
        </tr>
        <tr>
          <td width="40" valign="top"><span class="step-num" style="width:28px;height:28px;background-color:#0d7a5f;color:#ffffff;border-radius:50%;font-size:14px;font-weight:700;text-align:center;line-height:28px;display:inline-block;">3</span></td>
          <td valign="top"><p class="step-title" style="font-size:15px;font-weight:600;color:#1a1a1a;margin:0 0 2px 0;">Report in 24–48 hours</p><p class="step-desc" style="font-size:14px;color:#5f6368;margin:0;line-height:1.5;">Your signed, independently verifiable report arrives within 24–48 hours of the visit.</p></td>
        </tr>
      </table>
      ${button(trackUrl, 'Track your inspection')}
      <div class="card" style="background-color:#f4f7f6;border:1px solid #e5ebe9;border-radius:10px;padding:18px 20px;margin:0 0 16px 0;">
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Order</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 12px 0;">Inspection #${esc(sid)}</p>
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Property</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 12px 0;">${esc(vars.propertyAddress)}</p>
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Inspection type</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 12px 0;">${esc(vars.inspectionType)}</p>
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Amount</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0;">${esc(vars.amount)}</p>
      </div>`,
      });
    },
    text: (vars) => {
      const sid = shortId(vars.orderId);
      const name = vars.customerName ? `, ${vars.customerName}` : '';
      return `Order confirmed${name}

Inspection #${sid} is booked. What happens next:

1. Inspector dispatched — a licensed inspector is assigned within 2 business days and you'll get an email with their name.
2. Evidence sealed — every photo and finding is cryptographically sealed at capture, tamper-evident from day one.
3. Report in 24-48 hours — your signed, independently verifiable report arrives within 24-48 hours of the visit.

Track your inspection: ${vars.trackUrl || BRAND.url}

Order summary
  Order: Inspection #${sid}
  Property: ${vars.propertyAddress || ''}
  Inspection type: ${vars.inspectionType || ''}
  Amount: ${vars.amount || ''}

Questions? ${BRAND.email} / ${BRAND.phone}`;
    },
  },

  // ── 3. Inspector dispatched ─────────────────────────────────────────
  inspector_dispatched: {
    subject: (vars) => `Your inspector is on the way — #${shortId(vars.orderId)}`,
    html: (vars) => {
      const name = vars.customerName || '';
      const trackUrl = vars.trackUrl || BRAND.url;
      const sid = shortId(vars.orderId);
      return shell({
        preheader: `${vars.inspectorName || 'An inspector'} has been assigned to inspection #${sid}.`,
        title: `Inspector assigned — #${sid}`,
        body: `
      <h1 class="h1" style="font-size:22px;font-weight:700;color:#1a1a1a;margin:0 0 12px 0;">Your inspector is assigned${name ? `, ${esc(name)}` : ''}</h1>
      <p class="p" style="font-size:15px;line-height:1.6;color:#3c4043;margin:0 0 16px 0;"><strong>${esc(vars.inspectorName)}</strong> will inspect <strong>${esc(vars.propertyAddress)}</strong>. They'll reach out shortly to confirm access and timing.</p>
      <p class="p" style="font-size:15px;line-height:1.6;color:#3c4043;margin:0 0 16px 0;">What to expect:</p>
      <div class="card" style="background-color:#f4f7f6;border:1px solid #e5ebe9;border-radius:10px;padding:18px 20px;margin:0 0 16px 0;">
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 10px 0;">&check; The inspector confirms a visit window with you directly</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 10px 0;">&check; Photos and findings are cryptographically sealed on-site</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0;">&check; Your verifiable report arrives 24–48 hours after the visit</p>
      </div>
      ${button(trackUrl, 'Track your inspection')}
      <p class="small" style="font-size:13px;line-height:1.6;color:#5f6368;">Order: Inspection #${esc(sid)}</p>`,
      });
    },
    text: (vars) => {
      const sid = shortId(vars.orderId);
      const name = vars.customerName ? `, ${vars.customerName}` : '';
      return `Your inspector is assigned${name}

${vars.inspectorName || 'An inspector'} will inspect ${vars.propertyAddress || ''}. They'll reach out shortly to confirm access and timing.

What to expect:
- The inspector confirms a visit window with you directly
- Photos and findings are cryptographically sealed on-site
- Your verifiable report arrives 24-48 hours after the visit

Track your inspection: ${vars.trackUrl || BRAND.url}

Order: Inspection #${sid}

Questions? ${BRAND.email} / ${BRAND.phone}`;
    },
  },

  // ── 4. Report ready ────────────────────────────────────────────────
  report_ready: {
    subject: (vars) => `Your inspection report is ready — #${shortId(vars.orderId)}`,
    html: (vars) => {
      const name = vars.customerName || '';
      const proofUrl = vars.proofUrl || BRAND.url;
      const sid = shortId(vars.orderId);
      const hash = String(vars.bundleHashShort || '');
      return shell({
        preheader: `Inspection #${sid} is complete — view your signed report now.`,
        title: `Report ready — #${sid}`,
        body: `
      <h1 class="h1" style="font-size:22px;font-weight:700;color:#1a1a1a;margin:0 0 12px 0;">Your report is ready${name ? `, ${esc(name)}` : ''}</h1>
      <p class="p" style="font-size:15px;line-height:1.6;color:#3c4043;margin:0 0 16px 0;">The inspection of <strong>${esc(vars.propertyAddress)}</strong> is complete. Your report is cryptographically signed and independently verifiable — anyone can confirm it hasn't been altered.</p>
      ${button(proofUrl, 'View and download proof')}
      <div class="card" style="background-color:#f4f7f6;border:1px solid #e5ebe9;border-radius:10px;padding:18px 20px;margin:0 0 16px 0;">
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Order</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 12px 0;">Inspection #${esc(sid)}</p>
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Property</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 12px 0;">${esc(vars.propertyAddress)}</p>
        ${hash ? `<p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Bundle digest</p>
        <p class="row-value digest" style="font-size:15px;color:#1a1a1a;margin:0;font-family:monospace,monospace;font-size:13px;color:#0a5f4b;word-break:break-all;">${esc(hash)}</p>` : ''}
      </div>
      <p class="small" style="font-size:13px;line-height:1.6;color:#5f6368;">Keep this email — the digest above lets you (or any third party) independently verify the report's integrity at any time.</p>`,
      });
    },
    text: (vars) => {
      const sid = shortId(vars.orderId);
      const name = vars.customerName ? `, ${vars.customerName}` : '';
      const hash = String(vars.bundleHashShort || '');
      return `Your inspection report is ready${name}

The inspection of ${vars.propertyAddress || ''} is complete. Your report is cryptographically signed and independently verifiable — anyone can confirm it hasn't been altered.

View and download your proof: ${vars.proofUrl || BRAND.url}

Order: Inspection #${sid}
Property: ${vars.propertyAddress || ''}${hash ? `\nBundle digest: ${hash}` : ''}

Keep this email — the digest above lets you (or any third party) independently verify the report's integrity at any time.

Questions? ${BRAND.email} / ${BRAND.phone}`;
    },
  },

  // ── 5. Contractor assignment ───────────────────────────────────────
  contractor_assignment: {
    subject: (vars) => `New inspection assignment — ${vars.propertyAddress || 'new job'}`,
    html: (vars) => {
      const name = vars.contractorName || '';
      const portalUrl = vars.portalUrl || BRAND.url;
      const notes = String(vars.customerNotes || '').trim();
      return shell({
        preheader: `New ${vars.inspectionType || 'inspection'} job: ${vars.propertyAddress || ''}. Open your contractor app to accept.`,
        title: 'New inspection assignment',
        body: `
      <h1 class="h1" style="font-size:22px;font-weight:700;color:#1a1a1a;margin:0 0 12px 0;">New job assigned${name ? `, ${esc(name)}` : ''}</h1>
      <p class="p" style="font-size:15px;line-height:1.6;color:#3c4043;margin:0 0 16px 0;">You've been assigned an inspection. Review the details and accept it in your contractor app.</p>
      ${button(portalUrl, 'Open contractor app')}
      <div class="card" style="background-color:#f4f7f6;border:1px solid #e5ebe9;border-radius:10px;padding:18px 20px;margin:0 0 16px 0;">
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Order</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 12px 0;">Inspection #${esc(shortId(vars.orderId))}</p>
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Property</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0 0 12px 0;">${esc(vars.propertyAddress)}</p>
        <p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Inspection type</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0${notes ? ' 0 12px 0' : ''};">${esc(vars.inspectionType)}</p>
        ${notes ? `<p class="row-label" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5f6368;margin:0 0 2px 0;">Customer notes</p>
        <p class="row-value" style="font-size:15px;color:#1a1a1a;margin:0;">${esc(notes)}</p>` : ''}
      </div>
      <p class="small" style="font-size:13px;line-height:1.6;color:#5f6368;">Photos and findings must be sealed on-site through the app to keep the proof chain intact.</p>`,
      });
    },
    text: (vars) => {
      const name = vars.contractorName ? `, ${vars.contractorName}` : '';
      const notes = String(vars.customerNotes || '').trim();
      return `New inspection assignment${name}

You've been assigned an inspection. Review the details and accept it in your contractor app: ${vars.portalUrl || BRAND.url}

Job details
  Order: Inspection #${shortId(vars.orderId)}
  Property: ${vars.propertyAddress || ''}
  Inspection type: ${vars.inspectionType || ''}${notes ? `\n  Customer notes: ${notes}` : ''}

Photos and findings must be sealed on-site through the app to keep the proof chain intact.

Questions? ${BRAND.email} / ${BRAND.phone}`;
    },
  },
};

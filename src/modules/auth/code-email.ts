const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string)

/** Table layout and inline styles keep the code readable even in email clients with limited CSS support. */
export function createCodeEmail(code: string, audience: 'customer' | 'admin'): { text: string; html: string } {
  const isAdmin = audience === 'admin'
  const heading = isAdmin ? 'Your admin login code' : 'Your sign-in code'
  const introduction = isAdmin ? 'Use this code to finish signing in to your ShreeRam Milks admin account.' : 'Welcome to ShreeRam Milks. Enter this code in the app to finish signing in.'
  const security = isAdmin ? 'If you did not try to sign in, ignore this email and change your password.' : 'If you did not request this code, you can safely ignore this email.'
  return {
    text: `ShreeRam Milks\n\n${heading}\n\n${code}\n\nCopy the code above and paste it into ${isAdmin ? 'the admin sign-in screen' : 'the app'}.\nIt works once and expires in 10 minutes. Use only the most recent code.\n\n${security}\nNever share your sign-in code.`,
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading} | ShreeRam Milks</title></head>
<body style="margin:0;padding:0;background-color:#f4f5ef;color:#243c30;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Your one-time code is ready. It expires in 10 minutes.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5ef;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="padding:0 8px 24px;font-size:20px;font-weight:700;letter-spacing:-0.5px;color:#244b37;">ShreeRam <span style="font-weight:400;">Milks</span></td></tr>
        <tr><td style="padding:32px 24px;background-color:#ffffff;border:1px solid #dfe6dc;border-top:4px solid #244b37;border-radius:12px;">
          <p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;line-height:18px;color:#58705e;">${isAdmin ? 'ADMIN SIGN IN' : 'A FRESH START'}</p>
          <h1 style="margin:0 0 14px;font-size:28px;line-height:36px;letter-spacing:-0.8px;color:#243c30;">${heading}</h1>
          <p style="margin:0 0 28px;font-size:15px;line-height:24px;color:#637168;">${introduction}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:24px 8px;background-color:#eff5eb;border:1px solid #d8e5d2;border-radius:8px;">
              <p style="margin:0 0 10px;font-size:10px;font-weight:700;letter-spacing:2px;line-height:16px;color:#58705e;">VERIFICATION CODE</p>
              <code dir="ltr" style="display:block;margin:0;font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:700;letter-spacing:5px;line-height:48px;color:#244b37;white-space:nowrap;user-select:all;-webkit-user-select:all;">${escapeHtml(code)}</code>
            </td></tr>
          </table>
          <p style="margin:14px 0 24px;text-align:center;font-size:12px;line-height:20px;color:#637168;">Select the code to copy, then paste it into ${isAdmin ? 'the admin sign-in screen' : 'the app'}.</p>
          <p style="margin:0 0 24px;font-size:13px;line-height:22px;color:#637168;">Valid for <strong style="color:#243c30;">10 minutes</strong> &middot; One use only<br>Requested another code? Use the most recent email.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding-top:20px;border-top:1px solid #e8ece5;font-size:12px;line-height:20px;color:#778178;">${security}<br>Never share your sign-in code.</td></tr></table>
        </td></tr>
        <tr><td align="center" style="padding:22px 16px;font-size:11px;line-height:18px;color:#778178;">ShreeRam Milks<br>This is an automated sign-in email.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.replace(/>\s+</g, '><').trim(),
  }
}

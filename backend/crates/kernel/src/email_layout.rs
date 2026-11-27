//! Shared, email-client-safe layout and escaping helpers for transactional mail.

/// Escape an untrusted string for HTML text or a quoted attribute.
pub fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Keep subjects on one header line.
pub fn subject(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n'))
        .collect()
}

/// Render detail rows. Values are escaped and line breaks in values are preserved safely.
pub fn details(rows: &[(&str, &str)]) -> String {
    let rows = rows.iter().map(|(label, value)| format!(
        "<tr><td style=\"width:34%;padding:12px 14px;border-bottom:1px solid #d8d3c8;font:12px 'Courier New',monospace;text-transform:uppercase;color:#5E5A52;vertical-align:top;word-break:break-word\">{}</td><td style=\"width:66%;padding:12px 14px;border-bottom:1px solid #d8d3c8;font:15px Helvetica,Arial,sans-serif;color:#12110E;white-space:pre-wrap;word-break:break-all\">{}</td></tr>",
        escape(label), escape(value).replace('\n', "<br>")
    )).collect::<String>();
    format!(
        "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"border:1px solid #d8d3c8;border-collapse:collapse;margin:24px 0\">{rows}</table>"
    )
}

/// Render the primary square CTA and its visible raw URL.
pub fn button(url: &str, label: &str) -> String {
    let href = escape(url);
    format!(
        "<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" style=\"margin:26px 0 12px\"><tr><td bgcolor=\"#12110E\" style=\"padding:15px 20px\"><a href=\"{href}\" style=\"font:12px 'Courier New',monospace;letter-spacing:1px;text-transform:uppercase;color:#F3EEE3;text-decoration:none\">{}</a></td></tr></table><p style=\"font:12px Helvetica,Arial,sans-serif;color:#5E5A52;word-break:break-all\">If the button does not work, copy this link:<br><a href=\"{href}\" style=\"color:#2B4FD8\">{}</a></p>",
        escape(label),
        escape(url)
    )
}

/// Render a prominent one-time code block.
pub fn code(value: &str, expiry: &str) -> String {
    format!(
        "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"margin:24px 0;border:1px solid #12110E\"><tr><td align=\"center\" style=\"padding:22px 12px;font: bold 28px 'Courier New',monospace;letter-spacing:8px;color:#12110E\">{}</td></tr></table><p style=\"font:13px Helvetica,Arial,sans-serif;color:#5E5A52\">{}</p>",
        escape(value),
        escape(expiry)
    )
}

/// Wrap content in the Invigil brand shell. `content` must be generated from escaped values.
pub fn layout(eyebrow: &str, title: &str, preheader: &str, content: &str, reason: &str) -> String {
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>{}</title></head><body style="margin:0;padding:0;background:#F3EEE3;color:#12110E;font-family:Helvetica,Arial,sans-serif"><div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">{}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F3EEE3"><tr><td align="center" style="padding:28px 14px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid #12110E"><tr><td style="padding:20px 26px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td width="20" height="20" bgcolor="#12110E" style="width:20px;height:20px;background:#12110E"><table role="presentation" width="20" height="20" cellspacing="0" cellpadding="0"><tr><td width="14"></td><td width="6" bgcolor="#D23A1C" style="background:#D23A1C"></td></tr></table></td><td style="padding-left:10px;font:12px 'Courier New',monospace;letter-spacing:1.5px;color:#12110E">INVENTIX INVIGIL</td></tr></table></td></tr><tr><td height="3" bgcolor="#2B4FD8" style="height:3px;background:#2B4FD8"></td></tr><tr><td style="padding:36px 26px 30px"><p style="margin:0 0 12px;font:11px 'Courier New',monospace;letter-spacing:1px;color:#D23A1C">{}</p><h1 style="margin:0 0 20px;font:bold 30px Helvetica,Arial,sans-serif;line-height:1.2;color:#12110E">{}</h1>{}</td></tr><tr><td style="padding:18px 26px;border-top:1px solid #d8d3c8"><p style="margin:0 0 12px;font:12px/1.6 Helvetica,Arial,sans-serif;color:#5E5A52">{}</p><p style="margin:0 0 8px;font:bold 13px Helvetica,Arial,sans-serif;color:#12110E">Inventix Invigil &middot; Exams that hold up.</p><p style="margin:0 0 8px;font:12px/1.6 Helvetica,Arial,sans-serif;color:#5E5A52"><a href="mailto:info@inventixhq.com" style="color:#2B4FD8">info@inventixhq.com</a><br>COMSATS University Lahore, Pakistan</p><p style="margin:0;font:11px/1.5 Helvetica,Arial,sans-serif;color:#5E5A52">We never ask for your password by email.</p></td></tr></table></td></tr></table></body></html>"##,
        escape(title),
        escape(preheader),
        escape(eyebrow),
        escape(title),
        content,
        escape(reason)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_values_and_supplies_layout_markers() {
        let value = "<script>alert('&')</script>";
        let html = layout(
            "TEST / LABEL",
            "A heading",
            "preview",
            &details(&[("Name", value)]),
            "You requested this.",
        );
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script"));
        assert!(html.contains("name=\"color-scheme\""));
        assert!(html.contains("supported-color-schemes"));
        assert!(html.contains("&lt;script&gt;alert(&#39;&amp;&#39;)&lt;/script&gt;"));
        assert!(!subject("safe\r\nBcc: victim@example.test").contains(['\r', '\n']));
        assert!(button("https://example.test/?q=\"x\"", "Continue").contains("&quot;"));
        assert!(details(&[("Message", "first\nsecond")]).contains("first<br>second"));
    }
}

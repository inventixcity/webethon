//! Booking emails. They are sent in the background, so a slow mail server never slows a booking.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use kernel::{AppState, email::Email};

pub fn confirmed(to: &str, resource: &str, zone: Tz, starts: DateTime<Utc>) -> Email {
    let when = describe(zone, starts);
    Email {
        to: to.to_owned(),
        subject: format!("Booked: {resource}"),
        text: format!(
            "Your booking is confirmed.\n\n{resource}\n{when}\n\nTimes are shown in the resource's time zone ({zone}). To cancel, open My bookings before the start time."
        ),
        html: format!(
            "<p>Your booking is confirmed.</p><p><strong>{}</strong><br>{}</p><p>Times are shown in the resource's time zone ({}). To cancel, open My bookings before the start time.</p>",
            escape(resource),
            escape(&when),
            escape(&zone.to_string())
        ),
    }
}

pub fn cancelled(to: &str, resource: &str, zone: Tz, starts: DateTime<Utc>) -> Email {
    let when = describe(zone, starts);
    Email {
        to: to.to_owned(),
        subject: format!("Cancelled: {resource}"),
        text: format!(
            "Your booking has been cancelled.\n\n{resource}\n{when}\n\nYou can book another time in the app."
        ),
        html: format!(
            "<p>Your booking has been cancelled.</p><p><strong>{}</strong><br>{}</p><p>You can book another time in the app.</p>",
            escape(resource),
            escape(&when)
        ),
    }
}

/// For example "Saturday 30 March 2030, 09:00 BST". The zone abbreviation shows the clock change.
fn describe(zone: Tz, starts: DateTime<Utc>) -> String {
    starts
        .with_timezone(&zone)
        .format("%A %-d %B %Y, %H:%M %Z")
        .to_string()
}

pub fn send(state: &AppState, email: Email) {
    let sender = state.email.clone();
    tokio::spawn(async move {
        // Log the failure without the address or the message body.
        if let Err(error) = sender.send(&email).await {
            tracing::warn!(error = %error, "booking email delivery failed");
        }
    });
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

//! Input checks. Each check records a problem with its JSON path, so the client can fix every
//! field in one round trip. Problems come back as VALIDATION_FAILED with `details: [{path, message}]`.

use chrono::NaiveDate;
use chrono_tz::Tz;
use kernel::{AppError, AppResult, ErrorCode};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::{clock, schedule};

pub const NAME_MAX: usize = 120;
pub const DESCRIPTION_MAX: usize = 2000;
pub const NOTE_MAX: usize = 500;
pub const TIMEZONE_MAX: usize = 64;
pub const SEATS_MAX: i32 = 1000;

/// A one-off validation failure for a single field.
pub fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{ "path": path.trim_start_matches(['/', '?']).replace('/', "."), "message": message }]))
}

#[derive(Default)]
pub struct Problems(Vec<Value>);

impl Problems {
    pub fn add(&mut self, path: &str, message: &str) {
        self.0.push(json!({ "path": path.trim_start_matches(['/', '?']).replace('/', "."), "message": message }));
    }

    pub fn finish(self) -> AppResult<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(AppError::new(
                ErrorCode::ValidationFailed,
                "Please check the highlighted fields.",
            )
            .with_details(Value::Array(self.0)))
        }
    }
}

/// Trims, then checks length (in characters) and rejects control characters.
/// Line breaks are allowed only in `multiline` fields.
pub fn text(problems: &mut Problems, path: &str, raw: &str, max: usize, multiline: bool) -> String {
    let value = raw.trim().to_owned();
    if value.chars().count() > max {
        problems.add(path, &format!("Please keep this under {max} characters."));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !(multiline && character == '\n'))
    {
        problems.add(path, "Please remove the special characters.");
    }
    value
}

pub fn name(problems: &mut Problems, path: &str, raw: &str) -> String {
    let value = text(problems, path, raw, NAME_MAX, false);
    if value.is_empty() {
        problems.add(path, "Please give it a name.");
    }
    value
}

pub fn description(problems: &mut Problems, path: &str, raw: &str) -> String {
    text(problems, path, raw, DESCRIPTION_MAX, true)
}

pub fn note(problems: &mut Problems, path: &str, raw: &str) -> String {
    text(problems, path, raw, NOTE_MAX, true)
}

/// Accepts an IANA name exactly as published (case-sensitive, like "Europe/London").
pub fn timezone(problems: &mut Problems, path: &str, raw: &str) -> String {
    let value = raw.trim();
    match value.parse::<Tz>() {
        Ok(zone) if value.len() <= TIMEZONE_MAX => zone.to_string(),
        _ => {
            problems.add(path, "Pick a time zone such as Europe/London.");
            "UTC".to_owned()
        }
    }
}

pub fn slot_minutes(problems: &mut Problems, path: &str, value: i32) -> i32 {
    if !(5..=480).contains(&value) {
        problems.add(path, "Slots must be 5 to 480 minutes long.");
    }
    value
}

pub fn capacity(problems: &mut Problems, path: &str, value: i32) -> i32 {
    if !(1..=SEATS_MAX).contains(&value) {
        problems.add(path, "Capacity must be 1 to 1000 seats.");
    }
    value
}

pub fn seats(problems: &mut Problems, path: &str, value: i32) -> i32 {
    if !(1..=SEATS_MAX).contains(&value) {
        problems.add(path, "Seats must be 1 to 1000.");
    }
    value
}

pub fn visibility(problems: &mut Problems, path: &str, raw: &str) -> String {
    match raw {
        "private" | "public" => raw.to_owned(),
        _ => {
            problems.add(path, "Choose private or public.");
            "private".to_owned()
        }
    }
}

pub fn weekday(problems: &mut Problems, path: &str, value: i32) -> u32 {
    match u32::try_from(value) {
        Ok(day) if day <= 6 => day,
        _ => {
            problems.add(path, "Weekday must be 0 (Sunday) to 6 (Saturday).");
            0
        }
    }
}

pub fn clock_time(problems: &mut Problems, path: &str, raw: &str, end_of_day: bool) -> u16 {
    schedule::parse_clock(raw, end_of_day).unwrap_or_else(|| {
        problems.add(path, "Use a time like 09:30.");
        0
    })
}

pub fn instant(problems: &mut Problems, path: &str, raw: &str) -> OffsetDateTime {
    clock::parse_instant(raw).unwrap_or_else(|| {
        problems.add(
            path,
            "Use a time with an offset, such as 2030-03-31T09:00:00Z.",
        );
        OffsetDateTime::UNIX_EPOCH
    })
}

/// A calendar date written exactly as YYYY-MM-DD.
pub fn date(raw: &str) -> Option<NaiveDate> {
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok()?;
    (day.format("%Y-%m-%d").to_string() == raw).then_some(day)
}

/// Rejects overlapping windows on the same weekday. Sorts the list as a side effect.
pub fn no_overlaps(problems: &mut Problems, path: &str, windows: &mut [(u32, schedule::Window)]) {
    windows.sort();
    let overlap = windows
        .windows(2)
        .any(|pair| pair[0].0 == pair[1].0 && pair[1].1.start < pair[0].1.end);
    if overlap {
        problems.add(path, "Hours on the same day can't overlap.");
    }
}

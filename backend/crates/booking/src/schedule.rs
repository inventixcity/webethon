//! Pure scheduling rules: weekly hours and date exceptions become bookable slots.
//!
//! No database and no clock in here, so every rule (including daylight-saving changes) can be
//! unit-tested. Hours are wall-clock minutes in the resource's own time zone; everything else is UTC.

use std::collections::BTreeMap;

use chrono::{
    DateTime, Datelike, LocalResult, NaiveDate, NaiveTime, Offset, TimeDelta, TimeZone, Utc,
};
use chrono_tz::Tz;

/// Longest date range one slots request may cover (inclusive).
pub const MAX_RANGE_DAYS: i64 = 62;
/// Most slots one response may list. Keeps 5-minute grids bounded.
pub const MAX_SLOTS: usize = 5_000;
/// Most weekly windows a resource may have (eight per day).
pub const MAX_WEEKLY_WINDOWS: usize = 56;
/// Minutes after local midnight that mark the end of the day.
pub const END_OF_DAY: u16 = 1_440;

/// A stretch of local time, as minutes after midnight. `end` may be `END_OF_DAY`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Window {
    pub start: u16,
    pub end: u16,
}

/// Everything needed to lay out slots for a range of local dates.
#[derive(Clone, Debug)]
pub struct Hours {
    pub tz: Tz,
    pub slot: TimeDelta,
    /// Weekly windows as (weekday, window); weekday 0 is Sunday.
    pub weekly: Vec<(u32, Window)>,
    /// Per local date: `None` means closed; `Some` replaces the weekly windows for that date.
    pub exceptions: BTreeMap<NaiveDate, Option<Window>>,
}

/// One bookable slot. `starts` is the booking's `startsAt`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub starts: DateTime<Utc>,
    pub ends: DateTime<Utc>,
    /// Local date and times in the resource's time zone, for labels.
    pub local_date: NaiveDate,
    pub local_start: NaiveTime,
    pub local_end: NaiveTime,
}

/// A confirmed booking, reduced to what the capacity check needs.
#[derive(Clone, Copy, Debug)]
pub struct Booked {
    pub starts: DateTime<Utc>,
    pub ends: DateTime<Utc>,
    pub seats: i64,
}

/// Minutes after midnight as "HH:MM"; the end of the day is "24:00".
pub fn label(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// Parses a 24-hour "HH:MM". "24:00" is accepted only when `end_of_day` is true.
pub fn parse_clock(raw: &str, end_of_day: bool) -> Option<u16> {
    if end_of_day && raw == "24:00" {
        return Some(END_OF_DAY);
    }
    let bytes = raw.as_bytes();
    // Only ASCII digits and one colon pass, so the slices below are always on character boundaries.
    let shape_ok = bytes.len() == 5
        && bytes[2] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit());
    if !shape_ok {
        return None;
    }
    let hours: u16 = raw[..2].parse().ok()?;
    let minutes: u16 = raw[3..].parse().ok()?;
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

/// The local calendar date of an instant in `tz`.
pub fn local_date(tz: Tz, at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(&tz).date_naive()
}

/// The UTC instant of a local wall-clock minute on `date`.
///
/// When the clocks go back, an hour happens twice: the earlier instant is used. When they go
/// forward, some local times never happen: those move forward by the length of the gap, as a
/// clock on the wall would show them.
pub fn local_to_utc(tz: Tz, date: NaiveDate, minute: u16) -> Option<DateTime<Utc>> {
    let naive = date
        .and_time(NaiveTime::MIN)
        .checked_add_signed(TimeDelta::minutes(i64::from(minute)))?;
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(at) => Some(at.with_timezone(&Utc)),
        LocalResult::Ambiguous(earlier, _) => Some(earlier.with_timezone(&Utc)),
        LocalResult::None => {
            // Use the offset from a day earlier, which is the one in force just before the gap.
            let before = tz
                .offset_from_local_datetime(&naive.checked_sub_signed(TimeDelta::days(1))?)
                .earliest()?
                .fix();
            let utc = naive
                .checked_sub_signed(TimeDelta::seconds(i64::from(before.local_minus_utc())))?;
            Some(Utc.from_utc_datetime(&utc))
        }
    }
}

impl Hours {
    /// The windows that apply on one local date: an exception if there is one, else the weekly rules.
    fn windows_on(&self, day: NaiveDate) -> Vec<Window> {
        match self.exceptions.get(&day) {
            Some(Some(window)) => vec![*window],
            Some(None) => Vec::new(),
            None => {
                let weekday = day.weekday().num_days_from_sunday();
                let mut windows: Vec<Window> = self
                    .weekly
                    .iter()
                    .filter(|(day_of_week, _)| *day_of_week == weekday)
                    .map(|(_, window)| *window)
                    .collect();
                windows.sort();
                windows
            }
        }
    }
}

/// Every slot that starts on a local date from `first` to `last` (inclusive), in time order.
///
/// Slots are cut from the start of each window in steps of the slot length, so a window that
/// isn't a whole number of slots leaves its remainder unused. Slots are fixed in real time, so a
/// 09:00 slot stays at 09:00 local on both sides of a clock change.
pub fn generate(hours: &Hours, first: NaiveDate, last: NaiveDate) -> Vec<Slot> {
    let mut slots: BTreeMap<DateTime<Utc>, Slot> = BTreeMap::new();
    if hours.slot <= TimeDelta::zero() {
        return Vec::new();
    }
    let mut day = first;
    while day <= last {
        for window in hours.windows_on(day) {
            let (Some(open), Some(close)) = (
                local_to_utc(hours.tz, day, window.start),
                local_to_utc(hours.tz, day, window.end),
            ) else {
                continue;
            };
            let mut starts = open;
            while let Some(ends) = starts
                .checked_add_signed(hours.slot)
                .filter(|ends| *ends <= close)
            {
                let local = starts.with_timezone(&hours.tz);
                slots.entry(starts).or_insert(Slot {
                    starts,
                    ends,
                    local_date: local.date_naive(),
                    local_start: local.time(),
                    local_end: ends.with_timezone(&hours.tz).time(),
                });
                starts = ends;
            }
        }
        let Some(next) = day.succ_opt() else {
            break;
        };
        day = next;
    }
    slots.into_values().collect()
}

/// Whether `at` is exactly where a slot starts, ignoring bookings and the clock.
/// The caller must have loaded the exceptions for the day before and after `at` too.
pub fn is_slot_start(hours: &Hours, at: DateTime<Utc>) -> bool {
    let day = local_date(hours.tz, at);
    let (Some(first), Some(last)) = (day.pred_opt(), day.succ_opt()) else {
        return false;
    };
    generate(hours, first, last)
        .iter()
        .any(|slot| slot.starts == at)
}

/// Seats taken by confirmed bookings that overlap `[starts, ends)`.
pub fn seats_taken(booked: &[Booked], starts: DateTime<Utc>, ends: DateTime<Utc>) -> i64 {
    booked
        .iter()
        .filter(|booking| booking.starts < ends && booking.ends > starts)
        .map(|booking| booking.seats)
        .sum()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn date(raw: &str) -> NaiveDate {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d").unwrap()
    }

    fn utc(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    /// The same window on every weekday.
    fn daily(zone: Tz, slot_minutes: i64, start: u16, end: u16) -> Hours {
        Hours {
            tz: zone,
            slot: TimeDelta::minutes(slot_minutes),
            weekly: (0..7).map(|day| (day, Window { start, end })).collect(),
            exceptions: BTreeMap::new(),
        }
    }

    fn starts(slots: &[Slot]) -> Vec<DateTime<Utc>> {
        slots.iter().map(|slot| slot.starts).collect()
    }

    #[test]
    fn clock_parsing_is_strict() {
        assert_eq!(parse_clock("09:30", false), Some(570));
        assert_eq!(parse_clock("00:00", false), Some(0));
        assert_eq!(parse_clock("23:59", false), Some(1439));
        assert_eq!(parse_clock("24:00", false), None);
        assert_eq!(parse_clock("24:00", true), Some(END_OF_DAY));
        assert_eq!(parse_clock("9:30", false), None);
        assert_eq!(parse_clock("09:60", false), None);
        assert_eq!(parse_clock("+9:30", false), None);
        assert_eq!(parse_clock("09:3０", false), None);
        assert_eq!(label(570), "09:30");
        assert_eq!(label(END_OF_DAY), "24:00");
    }

    #[test]
    fn grid_is_cut_from_window_start_and_drops_remainder() {
        // 09:00 to 10:45 in 30-minute slots: 09:00, 09:30, 10:00. The last 15 minutes are unused.
        let hours = daily(chrono_tz::Tz::UTC, 30, 540, 645);
        let slots = generate(&hours, date("2030-03-04"), date("2030-03-04"));
        assert_eq!(slots.len(), 3);
        assert_eq!(
            slots[0].local_start,
            NaiveTime::from_hms_opt(9, 0, 0).unwrap()
        );
        assert_eq!(slots[2].ends, utc("2030-03-04T10:30:00Z"));
    }

    #[test]
    fn empty_or_zero_windows_produce_nothing() {
        let hours = daily(chrono_tz::Tz::UTC, 60, 540, 540);
        assert!(generate(&hours, date("2030-03-04"), date("2030-03-04")).is_empty());
        let zero_slot = daily(chrono_tz::Tz::UTC, 0, 540, 600);
        assert!(generate(&zero_slot, date("2030-03-04"), date("2030-03-04")).is_empty());
    }

    #[test]
    fn london_spring_forward_day_has_eight_hourly_slots_from_nine_local() {
        // 2027-03-28: clocks jump from 01:00 GMT to 02:00 BST. 09:00 to 17:00 is only 8 real hours.
        let hours = daily(chrono_tz::Europe::London, 60, 540, 1020);
        let slots = generate(&hours, date("2027-03-28"), date("2027-03-28"));
        assert_eq!(slots.len(), 8);
        assert_eq!(slots[0].starts, utc("2027-03-28T08:00:00Z"));
        assert_eq!(slots[7].ends, utc("2027-03-28T16:00:00Z"));
        assert!(
            slots
                .iter()
                .all(|slot| slot.local_date == date("2027-03-28"))
        );
    }

    #[test]
    fn london_spring_forward_full_day_has_23_slots() {
        let hours = daily(chrono_tz::Europe::London, 60, 0, END_OF_DAY);
        let slots = generate(&hours, date("2027-03-28"), date("2027-03-28"));
        assert_eq!(slots.len(), 23);
        assert_eq!(slots[0].starts, utc("2027-03-28T00:00:00Z"));
        assert_eq!(slots[22].ends, utc("2027-03-28T23:00:00Z"));
    }

    #[test]
    fn london_fall_back_full_day_has_25_slots() {
        // 2027-10-31: clocks go from 02:00 BST back to 01:00 GMT, so the day is 25 hours long.
        let hours = daily(chrono_tz::Europe::London, 60, 0, END_OF_DAY);
        let slots = generate(&hours, date("2027-10-31"), date("2027-10-31"));
        assert_eq!(slots.len(), 25);
        assert_eq!(slots[0].starts, utc("2027-10-30T23:00:00Z"));
        assert_eq!(slots[24].ends, utc("2027-11-01T00:00:00Z"));
    }

    #[test]
    fn london_fall_back_ambiguous_hour_takes_the_earlier_instant() {
        // 01:00 to 02:00 local happens twice on 2027-10-31. The first pass (BST) starts at 00:00Z.
        let hours = daily(chrono_tz::Europe::London, 60, 60, 120);
        let slots = generate(&hours, date("2027-10-31"), date("2027-10-31"));
        assert_eq!(
            starts(&slots),
            vec![utc("2027-10-31T00:00:00Z"), utc("2027-10-31T01:00:00Z")]
        );
    }

    #[test]
    fn london_spring_forward_gap_moves_forward_by_the_gap() {
        // 01:30 does not exist on 2027-03-28. It moves forward to 02:30 BST, which is 01:30Z.
        assert_eq!(
            local_to_utc(chrono_tz::Europe::London, date("2027-03-28"), 90),
            Some(utc("2027-03-28T01:30:00Z"))
        );
        let hours = daily(chrono_tz::Europe::London, 30, 90, 180);
        let slots = generate(&hours, date("2027-03-28"), date("2027-03-28"));
        assert_eq!(starts(&slots), vec![utc("2027-03-28T01:30:00Z")]);
    }

    #[test]
    fn new_york_clock_changes_give_23_and_25_hour_days() {
        let spring = daily(chrono_tz::America::New_York, 60, 0, END_OF_DAY);
        let spring_slots = generate(&spring, date("2027-03-14"), date("2027-03-14"));
        assert_eq!(spring_slots.len(), 23);
        assert_eq!(spring_slots[0].starts, utc("2027-03-14T05:00:00Z"));

        let fall = daily(chrono_tz::America::New_York, 60, 0, END_OF_DAY);
        let fall_slots = generate(&fall, date("2027-11-07"), date("2027-11-07"));
        assert_eq!(fall_slots.len(), 25);
        assert_eq!(fall_slots[24].ends, utc("2027-11-08T05:00:00Z"));
    }

    #[test]
    fn new_york_nine_to_five_keeps_local_nine_across_the_change() {
        let hours = daily(chrono_tz::America::New_York, 60, 540, 1020);
        let before = generate(&hours, date("2027-03-13"), date("2027-03-13"));
        let after = generate(&hours, date("2027-03-15"), date("2027-03-15"));
        assert_eq!(before[0].starts, utc("2027-03-13T14:00:00Z"));
        assert_eq!(after[0].starts, utc("2027-03-15T13:00:00Z"));
        assert_eq!(before[0].local_start, after[0].local_start);
    }

    #[test]
    fn closed_exception_removes_weekly_hours_and_custom_window_replaces_them() {
        let mut hours = daily(chrono_tz::Tz::UTC, 60, 540, 1020);
        hours.exceptions.insert(date("2030-03-04"), None);
        hours.exceptions.insert(
            date("2030-03-05"),
            Some(Window {
                start: 600,
                end: 660,
            }),
        );
        assert!(generate(&hours, date("2030-03-04"), date("2030-03-04")).is_empty());
        let custom = generate(&hours, date("2030-03-05"), date("2030-03-05"));
        assert_eq!(starts(&custom), vec![utc("2030-03-05T10:00:00Z")]);
        let normal = generate(&hours, date("2030-03-06"), date("2030-03-06"));
        assert_eq!(normal.len(), 8);
    }

    #[test]
    fn overlapping_weekly_windows_do_not_double_count_slots() {
        // Overlap is rejected on write; if it slipped through, the slot must still appear once.
        let mut hours = daily(chrono_tz::Tz::UTC, 60, 540, 600);
        hours.weekly.push((
            1,
            Window {
                start: 540,
                end: 600,
            },
        ));
        let slots = generate(&hours, date("2030-03-04"), date("2030-03-04"));
        assert_eq!(slots.len(), 1);
    }

    #[test]
    fn alignment_accepts_only_real_slot_starts() {
        let hours = daily(chrono_tz::Europe::London, 60, 540, 1020);
        assert!(is_slot_start(&hours, utc("2027-07-01T08:00:00Z")));
        assert!(!is_slot_start(&hours, utc("2027-07-01T08:30:00Z")));
        assert!(!is_slot_start(&hours, utc("2027-07-01T16:00:00Z")));
        assert!(is_slot_start(&hours, utc("2027-03-28T08:00:00Z")));
    }

    #[test]
    fn taken_seats_count_only_real_overlaps() {
        let booked = [Booked {
            starts: utc("2030-03-04T10:00:00Z"),
            ends: utc("2030-03-04T11:00:00Z"),
            seats: 2,
        }];
        let at =
            |raw_start: &str, raw_end: &str| seats_taken(&booked, utc(raw_start), utc(raw_end));
        assert_eq!(at("2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"), 2);
        assert_eq!(at("2030-03-04T10:30:00Z", "2030-03-04T11:30:00Z"), 2);
        assert_eq!(at("2030-03-04T09:00:00Z", "2030-03-04T10:00:00Z"), 0);
        assert_eq!(at("2030-03-04T11:00:00Z", "2030-03-04T12:00:00Z"), 0);
    }

    #[test]
    fn chrono_local_helpers_agree_with_the_zone() {
        let zone = chrono_tz::Europe::London;
        let summer = zone.with_ymd_and_hms(2030, 7, 1, 9, 0, 0).unwrap();
        assert_eq!(
            local_date(zone, summer.with_timezone(&Utc)),
            date("2030-07-01")
        );
    }
}
